import { Link } from "react-router-dom";
import { PROGRAM_ID } from "../config";
import { usePoll } from "../hooks";
import type { DeploymentStatus } from "../lib/deployment";

async function readStatus(): Promise<DeploymentStatus> {
  const response = await fetch("/api/deployment", { cache: "no-store" });
  if (!response.ok) throw new Error("Program availability could not be verified. Trading is unavailable.");
  const status = await response.json() as DeploymentStatus;
  if (status.programId !== PROGRAM_ID.toBase58()) throw new Error("The app and API use different deployments. Refresh before trading.");
  return status;
}

export function DeploymentNotice() {
  const status = usePoll(readStatus, [], 30_000);
  if (!status.error && status.data?.available) return null;
  return (
    <aside className="panel" role="status" style={{ margin: "12px auto", padding: "14px 18px", maxWidth: 1440 }}>
      <strong>{status.error || status.data?.reason || "Checking trading availability…"}</strong>
      <p style={{ margin: "6px 0 0" }}>
        Positions from the closed programs remain unavailable. New markets do not unlock those assets.{" "}
        <Link to="/me">View existing holdings and history →</Link>
      </p>
    </aside>
  );
}
