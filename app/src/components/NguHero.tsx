// Site-wide banner for /ngu, under the masthead on every page (on /ngu itself it stays, minus the link).
import { Link, useLocation } from "react-router-dom";
import { NGU_LABEL } from "../ngu";
import "../ngu.css";

export function NguHero() {
  const here = useLocation().pathname === "/ngu";
  const body = (
    <>
      <span className="ngu-hero-kicker meta">100x.broker × the remains of stacSOL</span>
      <span className="ngu-hero-line display">
        Staked SOL whose SOL rate <em>only goes up</em>
      </span>
      <span className="ngu-hero-sub">
        Every transfer is taxed; half the tax is burned, half becomes liquidity nobody can pull. Volume is the yield.
      </span>
      {!here && <span className="ngu-hero-cta">{NGU_LABEL()} →</span>}
    </>
  );
  return here ? (
    <div className="ngu-hero" aria-label="NGU">
      {body}
    </div>
  ) : (
    <Link to="/ngu" className="ngu-hero" aria-label={`${NGU_LABEL()}: read how it works`}>
      {body}
    </Link>
  );
}
