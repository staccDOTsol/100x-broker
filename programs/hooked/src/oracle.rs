//! Raydium CLMM observation ring -> TWAP tick. Only *stored* observations are used; the live
//! tick is never extrapolated, so a same-block push cannot reach the price.
//!
//! Sampling mode (dead CLMM rings and every non-CLMM `oracle_kind`) integrates a tick the program
//! reads itself over our own checkpoints; `ring` is `None` when there is no observation ring at all.

use {
    crate::{
        consts::*,
        error::HookedError,
        state::{Ckpt, Market},
    },
    pinocchio::{error::ProgramError, Address},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub ts: u32,
    pub tick_cumulative: i64,
}

pub fn check_header(data: &[u8], pool: &Address) -> Result<(), ProgramError> {
    if data.len() < RAY_OBS_RING + RAY_OBS_NUM * RAY_OBS_SIZE
        || data[..8] != RAY_OBS_DISC
        || &data[RAY_OBS_POOL..RAY_OBS_POOL + 32] != pool.as_array()
    {
        return Err(HookedError::InvalidOracle.into());
    }
    Ok(())
}

fn ring_point(data: &[u8], i: usize) -> Point {
    let o = RAY_OBS_RING + i * RAY_OBS_SIZE;
    Point {
        ts: u32::from_le_bytes(data[o..o + 4].try_into().unwrap()),
        tick_cumulative: i64::from_le_bytes(data[o + 4..o + 12].try_into().unwrap()),
    }
}

pub fn latest(data: &[u8]) -> Result<Point, ProgramError> {
    let idx = u16::from_le_bytes([data[RAY_OBS_INDEX], data[RAY_OBS_INDEX + 1]]) as usize;
    if idx >= RAY_OBS_NUM {
        return Err(HookedError::InvalidOracle.into());
    }
    let p = ring_point(data, idx);
    if p.ts == 0 {
        return Err(HookedError::InvalidOracle.into());
    }
    Ok(p)
}

/// Window start: the newest point at or before `latest.ts - window` among the ring (if any) and
/// our checkpoints; if nothing is that old, the oldest point available (shorter window).
pub fn window_start(ring: Option<&[u8]>, ckpts: &[Ckpt; CKPT_COUNT], latest: Point, window: u32) -> Point {
    let target = latest.ts.saturating_sub(window);
    let mut best: Option<Point> = None;
    let mut oldest = latest;
    let mut consider = |p: Point| {
        if p.ts == 0 || p.ts > latest.ts {
            return;
        }
        if p.ts <= target && best.map_or(true, |b| p.ts > b.ts) {
            best = Some(p);
        }
        if p.ts < oldest.ts {
            oldest = p;
        }
    };
    if let Some(data) = ring {
        for i in 0..RAY_OBS_NUM {
            consider(ring_point(data, i));
        }
    }
    for c in ckpts.iter() {
        consider(Point { ts: c.ts, tick_cumulative: c.tick_cumulative });
    }
    best.unwrap_or(oldest)
}

/// Mean tick over [start, end] in Q32.
pub fn twap_q32(start: Point, end: Point) -> Option<i64> {
    let dt = end.ts.checked_sub(start.ts)? as i128;
    if dt == 0 {
        return None;
    }
    let dc = (end.tick_cumulative as i128) - (start.tick_cumulative as i128);
    i64::try_from((dc << 32) / dt).ok()
}

/// Reads the oracle for `m`; returns (latest point, TWAP Q32) or None when there is no window.
pub fn read(data: &[u8], m: &Market) -> Result<Option<(Point, i64)>, ProgramError> {
    check_header(data, &m.oracle_pool)?;
    let end = latest(data)?;
    let start = window_start(Some(data), &m.ckpts, end, m.window_secs);
    Ok(twap_q32(start, end).map(|t| (end, t)))
}

/// True when the ring has recorded nothing for RING_STALE_SECS (or never did).
pub fn ring_is_stale(data: &[u8], now: u32) -> bool {
    match latest(data) {
        Ok(p) => p.ts.saturating_add(RING_STALE_SECS) < now,
        Err(_) => true,
    }
}

/// Self-sampled end point: the newest known cumulative (ring or our checkpoints) extended with the
/// pool's current tick over the elapsed time — the same integral Raydium would have stored. A sample
/// only moves the TWAP by elapsed/window, so a one-slot price push is worth almost nothing.
pub fn sampled_end(ring: Option<&[u8]>, m: &Market, now: u32, tick: i32) -> Point {
    let ring = ring.and_then(|d| latest(d).ok()).unwrap_or(Point { ts: 0, tick_cumulative: 0 });
    let ck = m.newest_ckpt();
    let base = if ck.ts >= ring.ts { Point { ts: ck.ts, tick_cumulative: ck.tick_cumulative } } else { ring };
    if base.ts == 0 || now <= base.ts {
        return Point { ts: now, tick_cumulative: base.tick_cumulative };
    }
    let dt = (now - base.ts) as i64;
    Point { ts: now, tick_cumulative: base.tick_cumulative.saturating_add(tick as i64 * dt) }
}

/// Oracle read in sampling mode: (end, TWAP or None while there is no window yet). `ring` is the
/// CLMM observation account for kind 0 (header-checked) and `None` for every other kind.
pub fn read_sampled(ring: Option<&[u8]>, m: &Market, now: u32, tick: i32) -> Result<(Point, Option<i64>), ProgramError> {
    if let Some(d) = ring {
        check_header(d, &m.oracle_pool)?;
    }
    let end = sampled_end(ring, m, now, tick);
    let start = window_start(ring, &m.ckpts, end, m.window_secs);
    Ok((end, twap_q32(start, end)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(points: &[(u32, i64)], idx: u16, pool: &Address) -> [u8; 4483] {
        let mut d = [0u8; 4483];
        d[..8].copy_from_slice(&RAY_OBS_DISC);
        d[RAY_OBS_INDEX..RAY_OBS_INDEX + 2].copy_from_slice(&idx.to_le_bytes());
        d[RAY_OBS_POOL..RAY_OBS_POOL + 32].copy_from_slice(pool.as_array());
        for (i, (ts, tc)) in points.iter().enumerate() {
            let o = RAY_OBS_RING + i * RAY_OBS_SIZE;
            d[o..o + 4].copy_from_slice(&ts.to_le_bytes());
            d[o + 4..o + 12].copy_from_slice(&tc.to_le_bytes());
        }
        d
    }

    #[test]
    fn twap_constant_tick() {
        let pool = Address::new_from_array([7; 32]);
        // tick 30000 held: cumulative grows 30000/s; 30 s spacing
        let pts: [(u32, i64); 100] =
            core::array::from_fn(|i| (1_000 + 30 * i as u32, 30_000 * 30 * i as i64));
        let d = ring(&pts, 99, &pool);
        check_header(&d, &pool).unwrap();
        let end = latest(&d).unwrap();
        assert_eq!(end.ts, 1_000 + 30 * 99);
        let ck = [Ckpt::default(); CKPT_COUNT];
        let s = window_start(Some(&d), &ck, end, 600);
        assert_eq!(end.ts - s.ts, 600);
        assert_eq!(twap_q32(s, end).unwrap(), 30_000i64 << 32);
        // window longer than the ring -> oldest point
        let s = window_start(Some(&d), &ck, end, 100_000);
        assert_eq!(s.ts, 1_000);
    }

    #[test]
    fn sampled_twap_from_dead_ring() {
        let pool = Address::new_from_array([7; 32]);
        // one ancient observation, as the dead pools have
        let d = ring(&[(1_000, 0)], 0, &pool);
        let mut m = unsafe { core::mem::zeroed::<Market>() };
        m.oracle_pool = pool;
        m.window_secs = 600;
        let now = 1_000 + 86_400 * 100;
        assert!(ring_is_stale(&d, now));
        // first sample: the only older point is the ring's, so the TWAP is the sampled tick itself
        let (end, t) = read_sampled(Some(&d), &m, now, 500).unwrap();
        assert_eq!(t.unwrap() >> 32, 500);
        m.push_ckpt(end.ts, end.tick_cumulative);
        // 300 s at tick 700, then 300 s at tick 300: 600 s window averages to 500
        let (end2, _) = read_sampled(Some(&d), &m, now + 300, 700).unwrap();
        m.push_ckpt(end2.ts, end2.tick_cumulative);
        let (_, t3) = read_sampled(Some(&d), &m, now + 600, 300).unwrap();
        assert_eq!(t3.unwrap() >> 32, 500);
    }

    /// Kinds 1-4: no ring at all. Creation seeds one checkpoint at (now, 0); the first rebalance
    /// then sees a short window made of the sampled tick alone, and the window fills from there.
    #[test]
    fn sampled_twap_without_ring() {
        let mut m = unsafe { core::mem::zeroed::<Market>() };
        m.window_secs = 600;
        let now = 1_700_000_000u32;
        // creation: no checkpoint yet -> no window, caller falls back to the sampled tick
        let (end, t) = read_sampled(None, &m, now, -22_241).unwrap();
        assert_eq!((end.ts, end.tick_cumulative), (now, 0));
        assert!(t.is_none());
        m.push_ckpt(end.ts, end.tick_cumulative);
        // 200 s later at the same tick: window is only 200 s long but the mean is exact
        let (end, t) = read_sampled(None, &m, now + 200, -22_241).unwrap();
        assert_eq!(end.tick_cumulative, -22_241i64 * 200);
        assert_eq!(t.unwrap() >> 32, -22_241);
        m.push_ckpt(end.ts, end.tick_cumulative);
        // checkpoints are CKPT_SPACING_SECS apart: 400 s at -22_241 then 200 s at -21_941 over a
        // 600 s window: mean -22_141
        let (end, _) = read_sampled(None, &m, now + 400, -22_241).unwrap();
        m.push_ckpt(end.ts, end.tick_cumulative);
        assert_eq!(m.newest_ckpt().ts, now + 400);
        let (end, t) = read_sampled(None, &m, now + 600, -21_941).unwrap();
        assert_eq!(t.unwrap() >> 32, -22_141);
        m.push_ckpt(end.ts, end.tick_cumulative);
        // same-second re-read does not integrate anything (dt = 0 from the newest checkpoint)
        let (again, _) = read_sampled(None, &m, now + 600, 999_999).unwrap();
        assert_eq!(again, end);
    }

    #[test]
    fn checkpoints_extend_window() {
        let pool = Address::new_from_array([7; 32]);
        let pts: [(u32, i64); 100] =
            core::array::from_fn(|i| (10_000 + 15 * i as u32, -5 * 15 * i as i64));
        let d = ring(&pts, 99, &pool);
        let mut ck = [Ckpt::default(); CKPT_COUNT];
        ck[0] = Ckpt { ts: 10_000 - 3_000, _pad: 0, tick_cumulative: 5 * 3_000 };
        let end = latest(&d).unwrap();
        let s = window_start(Some(&d), &ck, end, 3_960);
        assert_eq!(s.ts, 7_000);
        assert_eq!(twap_q32(s, end).unwrap() >> 32, -5);
    }
}
