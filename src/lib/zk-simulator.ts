/**
 * Local ZKTeco protocol simulator (TCP + UDP 4370). Test-only. Never talks to a real device.
 * Speaks the same packet format as zk-client.ts. Read-only replies.
 */
import net from "node:net";
import dgram from "node:dgram";
import {
  CMD_ACK_OK, CMD_ACK_UNAUTH, CMD_ATTLOG_RRQ, CMD_AUTH, CMD_CONNECT, CMD_DATA,
  CMD_EXIT, CMD_OPTIONS_RRQ, CMD_PREPARE_DATA, CMD_USERTEMP_RRQ, CMD_VERSION,
  TcpAssembler, USHRT_MAX, decodePayload, encodePayload, encodePunch, encodeUser,
  makeCommKey, parseOptionReply, wrapTcp, type ZkPunch, type ZkUser,
} from "./zk-protocol";

export type SimDevice = {
  commKey?: number;
  firmware?: string;
  serial?: string;
  deviceName?: string;
  users?: ZkUser[];
  punches?: ZkPunch[];
};

export type ZkSimulator = {
  port: number;
  host: string;
  close: () => Promise<void>;
};

function reply(sessionId: number, replyId: number, command: number, data: Buffer = Buffer.alloc(0)): Buffer {
  return encodePayload(command, sessionId, replyId, data);
}

function handle(state: Required<SimDevice> & { sessionId: number }, req: ReturnType<typeof decodePayload>): Buffer[] {
  const sid = req.command === CMD_CONNECT ? (state.sessionId = Math.max(1, (state.sessionId + 1) & USHRT_MAX)) : state.sessionId;
  if (req.command === CMD_CONNECT) {
    if (state.commKey) return [reply(sid, req.replyId, CMD_ACK_UNAUTH)];
    return [reply(sid, req.replyId, CMD_ACK_OK)];
  }
  if (req.command === CMD_AUTH) {
    const expect = makeCommKey(state.commKey, sid);
    if (req.data.length >= 4 && req.data.subarray(0, 4).equals(expect)) return [reply(sid, req.replyId, CMD_ACK_OK)];
    return [reply(sid, req.replyId, 2001)];
  }
  if (req.command === CMD_VERSION) return [reply(sid, req.replyId, CMD_ACK_OK, Buffer.from(`${state.firmware}\0`))];
  if (req.command === CMD_OPTIONS_RRQ) {
    const raw = req.data.toString("utf8").replace(/\0/g, "");
    const name = raw.split("=")[0] || raw;
    const val = name.includes("Serial") ? state.serial : name.includes("Device") ? state.deviceName : "";
    return [reply(sid, req.replyId, CMD_ACK_OK, Buffer.from(`${name}=${val}\0`))];
  }
  if (req.command === CMD_USERTEMP_RRQ) {
    const body = Buffer.concat((state.users || []).map(encodeUser));
    const prep = Buffer.alloc(4); prep.writeUInt32LE(body.length, 0);
    return [reply(sid, req.replyId, CMD_PREPARE_DATA, prep), reply(sid, req.replyId, CMD_DATA, body)];
  }
  if (req.command === CMD_ATTLOG_RRQ) {
    const body = Buffer.concat((state.punches || []).map(encodePunch));
    const prep = Buffer.alloc(4); prep.writeUInt32LE(body.length, 0);
    return [reply(sid, req.replyId, CMD_PREPARE_DATA, prep), reply(sid, req.replyId, CMD_DATA, body)];
  }
  if (req.command === CMD_EXIT) return [reply(sid, req.replyId, CMD_ACK_OK)];
  return [reply(sid, req.replyId, CMD_ACK_OK)];
}

export async function startZkSimulator(cfg: SimDevice = {}, port = 0): Promise<ZkSimulator> {
  const state = {
    commKey: Number(cfg.commKey || 0) || 0,
    firmware: cfg.firmware || "ZLM31-FXO1-3.1.6-SIM",
    serial: cfg.serial || "BADQ240624298",
    deviceName: cfg.deviceName || "LX19W",
    users: cfg.users || [],
    punches: cfg.punches || [],
    sessionId: 1000,
  };

  const tcp = net.createServer((sock) => {
    const asm = new TcpAssembler();
    const sess = { ...state, sessionId: state.sessionId };
    sock.on("data", (chunk) => {
      try {
        for (const p of asm.push(chunk)) {
          const req = decodePayload(p);
          for (const out of handle(sess, req)) sock.write(wrapTcp(out));
        }
      } catch { sock.destroy(); }
    });
  });

  const udp = dgram.createSocket("udp4");
  const udpSess = { ...state, sessionId: state.sessionId };
  udp.on("message", (msg, rinfo) => {
    try {
      const req = decodePayload(msg);
      for (const out of handle(udpSess, req)) udp.send(out, rinfo.port, rinfo.address);
    } catch { /* ignore */ }
  });

  const listenPort: number = await new Promise((resolve, reject) => {
    tcp.listen(port, "127.0.0.1", () => {
      const addr = tcp.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      udp.bind(p, "127.0.0.1", () => resolve(p));
    });
    tcp.once("error", reject);
  });

  return {
    port: listenPort,
    host: "127.0.0.1",
    close: async () => {
      await new Promise<void>((r) => udp.close(() => r()));
      await new Promise<void>((r) => tcp.close(() => r()));
    },
  };
}

void parseOptionReply;
