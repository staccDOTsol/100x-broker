import { useEffect, useState } from "react";
import { getUnderlying, type Underlying } from "../lib/das";

export function useUnderlying(mint: string | undefined) {
  const [u, setU] = useState<Underlying | null>(null);
  useEffect(() => {
    let alive = true;
    setU(null);
    if (mint) getUnderlying(mint).then((v) => alive && setU(v));
    return () => {
      alive = false;
    };
  }, [mint]);
  return u;
}
