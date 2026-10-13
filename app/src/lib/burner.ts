import {
  BaseMessageSignerWalletAdapter,
  WalletConnectionError,
  WalletNotConnectedError,
  WalletReadyState,
  WalletSignMessageError,
  WalletSignTransactionError,
  type TransactionOrVersionedTransaction,
  type WalletName,
} from "@solana/wallet-adapter-base";
import { Keypair, type PublicKey, type Transaction, type TransactionVersion, VersionedTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { SITE_URL } from "../config";

export const BURNER_NAME = "Burner" as WalletName<"Burner">;
/** One key per browser: base58 of the 64-byte secret. Bump the suffix if the format ever changes. */
const STORAGE_KEY = "burner:v1";
// a match, not a logo; neutral grey so it reads on both papers
const ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#8a8a8a" d="M12 2c1 3.5 4 5 4 9a4 4 0 0 1-8 0c0-1.6.7-2.6 1.4-3.6.4 1.2 1.1 1.9 1.6 1.9.6 0 .9-.6.9-1.3C11.9 6 10.6 4.6 12 2z"/><rect x="10.5" y="15" width="3" height="7" rx="1" fill="#8a8a8a"/></svg>',
  );

// storage can be off (private mode, blocked site data); then the key lives here for the life of the tab
let memKey: Keypair | null = null;

function load(): Keypair | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? Keypair.fromSecretKey(bs58.decode(raw)) : null;
  } catch {
    return null;
  }
}
function save(kp: Keypair): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, bs58.encode(kp.secretKey));
    return true;
  } catch {
    return false;
  }
}

/** A throwaway signer that lives in this browser, so a stranger can press buttons without trusting the site with a real wallet. */
export class BurnerWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = BURNER_NAME;
  url = SITE_URL;
  icon = ICON;
  readyState = WalletReadyState.Loadable;
  readonly supportedTransactionVersions: ReadonlySet<TransactionVersion> = new Set(["legacy", 0]);
  /** False when localStorage refused the write: the key is in memory only and dies with the tab. */
  persisted = true;
  private _keypair: Keypair | null = null;
  private _connecting = false;

  get publicKey(): PublicKey | null {
    return this._keypair?.publicKey ?? null;
  }
  get connecting(): boolean {
    return this._connecting;
  }

  /** Loads the stored key or mints one. Never prompts: there is nothing to approve. */
  async connect(): Promise<void> {
    if (this.connected || this._connecting) return;
    this._connecting = true;
    try {
      const stored = load();
      const kp = stored ?? memKey ?? Keypair.generate();
      this.persisted = !!stored || save(kp);
      if (!this.persisted) memKey = kp;
      this._keypair = kp;
      this.emit("connect", kp.publicKey);
    } catch (e) {
      const err = new WalletConnectionError((e as Error)?.message, e);
      this.emit("error", err);
      throw err;
    } finally {
      this._connecting = false;
    }
  }

  /** Forgets the key for this session only; storage keeps it, so the SOL is still there next time. */
  async disconnect(): Promise<void> {
    this._keypair = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends TransactionOrVersionedTransaction<this["supportedTransactionVersions"]>>(tx: T): Promise<T> {
    const kp = this._keypair;
    if (!kp) throw new WalletNotConnectedError();
    try {
      if (tx instanceof VersionedTransaction) tx.sign([kp]);
      else (tx as Transaction).partialSign(kp);
      return tx;
    } catch (e) {
      throw new WalletSignTransactionError((e as Error)?.message, e);
    }
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const kp = this._keypair;
    if (!kp) throw new WalletNotConnectedError();
    try {
      return ed25519.sign(message, kp.secretKey.slice(0, 32)); // web3's secretKey is seed ‖ pubkey; ed25519 wants the seed
    } catch (e) {
      throw new WalletSignMessageError((e as Error)?.message, e);
    }
  }

  /** Base58 of the whole 64-byte secret (what Phantom/Solflare import). Only the export button calls this; never log it. */
  exportSecret(): string | null {
    return this._keypair ? bs58.encode(this._keypair.secretKey) : null;
  }
}
