import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, type Connection } from "@solana/web3.js";
import { bagOf } from "./warbag.js";
import { factoryPda, gamePda, playerPda, WAR_PROGRAM } from "../../src/lib/war.js";

test("quote bags discover fresh forks, retain zero-dividend keys, and batch every account read", async () => {
  const wallet = PublicKey.unique();
  const token = PublicKey.unique();
  const accounts = new Map<string, Buffer>();
  const sizes: number[] = [];
  let next = 3;
  const game = (id: number, mint: PublicKey | null, dividend: bigint) => {
    const data = Buffer.alloc(297);
    Buffer.from([27, 90, 166, 125, 74, 100, 121, 18]).copy(data);
    data.writeBigUInt64LE(1n, 104);
    data.writeBigUInt64LE(dividend & ((1n << 64n) - 1n), 234);
    data.writeBigUInt64LE(dividend >> 64n, 242);
    if (mint) { data[250] = 1; mint.toBuffer().copy(data, 251); data[283] = 6; }
    accounts.set(gamePda(id).toBase58(), data);
  };
  const held = (id: number, keys: number) => {
    const data = Buffer.alloc(28);
    data.writeUInt32LE(keys, 8);
    accounts.set(playerPda(gamePda(id), wallet).toBase58(), data);
  };
  const info = (data: Buffer | undefined) => data ? { data, executable: false, lamports: 1, owner: WAR_PROGRAM, rentEpoch: 0 } : null;
  const mock = {
    async getAccountInfo(key: PublicKey) {
      assert.equal(key.toBase58(), factoryPda().toBase58());
      const data = Buffer.alloc(80);
      Buffer.from([159, 68, 192, 61, 48, 249, 216, 202]).copy(data);
      data.writeBigUInt64LE(BigInt(next), 72);
      return info(data);
    },
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      sizes.push(keys.length);
      assert.ok(keys.length <= 100, "Solana RPC permits no more than 100 accounts per request");
      return keys.map((key) => info(accounts.get(key.toBase58())));
    },
  } as unknown as Connection;
  game(0, null, 100n * 10n ** 18n); held(0, 2);
  game(1, token, 50n * 10n ** 18n); held(1, 3);
  game(2, null, 0n); held(2, 4);

  let rows = await bagOf(mock, wallet, null);
  assert.deepEqual(rows.map((row) => row.game.id), [0, 2]);
  assert.equal(rows.reduce((sum, row) => sum + row.keys, 0), 6);
  assert.equal(rows.reduce((sum, row) => sum + row.owed, 0n), 200n);
  assert.equal(rows.find((row) => row.game.id === 2)?.keys, 4);

  // The existing index is still warm: the new factory ID must appear without a minute-long wait.
  next = 4;
  game(3, null, 3n * 10n ** 18n); held(3, 1);
  game(0, null, 125n * 10n ** 18n);
  rows = await bagOf(mock, wallet, null);
  assert.deepEqual(rows.map((row) => row.game.id), [0, 2, 3]);
  assert.equal(rows.reduce((sum, row) => sum + row.owed, 0n), 253n);
  assert.deepEqual((await bagOf(mock, wallet, token.toBase58())).map((row) => row.game.id), [1]);
  assert.equal((await bagOf(mock, wallet)).length, 4, "absent mint retains the all-quote behavior");

  next = 124;
  for (let id = 4; id < next; id++) { game(id, null, 1n * 10n ** 18n); held(id, 1); }
  rows = await bagOf(mock, wallet, null);
  assert.equal(rows.length, 123);
  assert.ok(sizes.includes(100));
  assert.ok(sizes.every((size) => size <= 100));
});
