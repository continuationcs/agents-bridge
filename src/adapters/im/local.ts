import { createInterface, type Interface } from 'node:readline';
import type { InboundMessage } from '../../core/router.ts';
import type { ImAdapter, OutboundMessage } from './types.ts';

/** `bridge chat`: the terminal acts as a DM, so routes from `local:*` can be tried without any IM. */
export class LocalConsoleAdapter implements ImAdapter {
  readonly platform = 'local';
  readonly maxTextLength = 100_000;
  private readonly as: string;
  private rl?: Interface;
  private n = 0;

  constructor(opts: { as: string }) {
    this.as = opts.as;
  }

  async start(onMessage: (msg: InboundMessage) => void) {
    this.rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${this.as}> ` });
    this.rl.on('line', (line) => {
      const text = line.trim();
      if (text) {
        const id = String(++this.n);
        onMessage({
          platform: 'local',
          channelId: 'console',
          channelName: 'console',
          isDM: true,
          userId: this.as,
          text,
          mentioned: true,
          threadId: 'console',
          messageId: id,
        });
      }
      this.rl?.prompt();
    });
    this.rl.on('close', () => process.emit('SIGINT'));
    this.rl.prompt();
  }

  async stop() {
    this.rl?.close();
  }

  async send(msg: OutboundMessage): Promise<string> {
    this.print(msg.text);
    return String(++this.n);
  }

  async edit(_channelId: string, _messageId: string, text: string) {
    this.print(text);
  }

  private print(text: string) {
    process.stdout.write(`\r${text}\n`);
    this.rl?.prompt(true);
  }
}
