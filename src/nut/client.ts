import net from 'node:net';
import { NutError, isListCommand, parseListReply, parseSingleReply, quote, tokenize } from './protocol.js';

export interface NutConnectionOptions {
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
  /** How long a single command may take before the connection is torn down. */
  timeoutMs?: number;
}

export interface UpsListEntry {
  name: string;
  description: string;
}

interface PendingCommand {
  command: string;
  expectsList: boolean;
  lines: string[];
  resolve: (lines: string[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A single TCP conversation with `upsd`. Commands are serialised: the protocol
 * has no request identifiers, so replies are matched to commands by order.
 */
export class NutConnection {
  private readonly socket: net.Socket;
  private readonly timeoutMs: number;
  private readonly queue: PendingCommand[] = [];
  private buffer = '';
  private closed = false;

  private constructor(socket: net.Socket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (error) => this.failAll(error));
    socket.on('close', () => this.failAll(new Error('NUT connection closed by peer')));
  }

  static async connect(options: NutConnectionOptions): Promise<NutConnection> {
    const timeoutMs = options.timeoutMs ?? 8000;

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host: options.host, port: options.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`Timed out connecting to ${options.host}:${options.port}`));
      }, timeoutMs);

      s.once('connect', () => {
        clearTimeout(timer);
        s.removeAllListeners('error');
        resolve(s);
      });
      s.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const connection = new NutConnection(socket, timeoutMs);

    if (options.username) {
      await connection.send(`USERNAME ${options.username}`);
      if (options.password) {
        await connection.send(`PASSWORD ${options.password}`);
      }
    }

    return connection;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Sends a raw command and resolves with the reply lines (list block included). */
  send(command: string): Promise<string[]> {
    if (this.closed) {
      return Promise.reject(new Error('NUT connection is closed'));
    }

    return new Promise<string[]>((resolve, reject) => {
      const pending: PendingCommand = {
        command,
        expectsList: isListCommand(command),
        lines: [],
        resolve,
        reject,
        timer: setTimeout(() => {
          this.failAll(new Error(`Timed out waiting for reply to "${command}"`));
        }, this.timeoutMs),
      };

      this.queue.push(pending);
      this.socket.write(`${command}\n`);
    });
  }

  async listUps(): Promise<UpsListEntry[]> {
    const lines = await this.send('LIST UPS');
    const reply = parseListReply(lines, 'LIST UPS');
    return reply.rows.map((row) => ({ name: row[0] ?? '', description: row[1] ?? '' }));
  }

  async listVars(ups: string): Promise<Record<string, string>> {
    const command = `LIST VAR ${ups}`;
    const reply = parseListReply(await this.send(command), command);
    const vars: Record<string, string> = {};
    // Rows arrive as [upsName, variable, value].
    for (const row of reply.rows) {
      if (row[1] !== undefined) vars[row[1]] = row[2] ?? '';
    }
    return vars;
  }

  /** Variables the server will accept a `SET VAR` for. */
  async listWritableVars(ups: string): Promise<Record<string, string>> {
    const command = `LIST RW ${ups}`;
    const reply = parseListReply(await this.send(command), command);
    const vars: Record<string, string> = {};
    for (const row of reply.rows) {
      if (row[1] !== undefined) vars[row[1]] = row[2] ?? '';
    }
    return vars;
  }

  async listCommands(ups: string): Promise<string[]> {
    const command = `LIST CMD ${ups}`;
    const reply = parseListReply(await this.send(command), command);
    return reply.rows.map((row) => row[1] ?? '').filter(Boolean).sort();
  }

  async describeCommand(ups: string, cmd: string): Promise<string> {
    const command = `GET CMDDESC ${ups} ${cmd}`;
    const tokens = parseSingleReply((await this.send(command))[0] ?? '', command);
    return tokens[3] ?? '';
  }

  async describeVar(ups: string, name: string): Promise<string> {
    const command = `GET DESC ${ups} ${name}`;
    const tokens = parseSingleReply((await this.send(command))[0] ?? '', command);
    return tokens[3] ?? '';
  }

  async runCommand(ups: string, cmd: string): Promise<void> {
    const command = `INSTCMD ${ups} ${cmd}`;
    parseSingleReply((await this.send(command))[0] ?? '', command);
  }

  async setVar(ups: string, name: string, value: string): Promise<void> {
    const command = `SET VAR ${ups} ${name} ${quote(value)}`;
    parseSingleReply((await this.send(command))[0] ?? '', command);
  }

  async version(): Promise<string> {
    const lines = await this.send('VER');
    return (lines[0] ?? '').trim();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.send('LOGOUT');
    } catch {
      // The server frequently drops the socket on LOGOUT; nothing to recover.
    }
    this.destroy();
  }

  destroy(): void {
    this.closed = true;
    this.socket.destroy();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;

    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.onLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    const pending = this.queue[0];
    if (!pending) return; // Unsolicited output; the protocol has none, so ignore.

    pending.lines.push(line);

    const tokens = tokenize(line);
    const isError = pending.lines.length === 1 && tokens[0] === 'ERR';
    const isListEnd = tokens[0] === 'END' && tokens[1] === 'LIST';
    const complete = isError || (pending.expectsList ? isListEnd : true);

    if (!complete) return;

    this.queue.shift();
    clearTimeout(pending.timer);

    if (isError) {
      pending.reject(new NutError(tokens[1] ?? 'UNKNOWN', pending.command));
    } else {
      pending.resolve(pending.lines);
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
    while (this.queue.length > 0) {
      const pending = this.queue.shift();
      if (!pending) break;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.socket.destroy();
  }
}

/** Opens a short-lived connection, runs `fn`, and always closes afterwards. */
export async function withNutConnection<T>(
  options: NutConnectionOptions,
  fn: (connection: NutConnection) => Promise<T>,
): Promise<T> {
  const connection = await NutConnection.connect(options);
  try {
    return await fn(connection);
  } finally {
    connection.destroy();
  }
}
