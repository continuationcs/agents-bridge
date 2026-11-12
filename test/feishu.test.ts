import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FeishuAdapter, card } from '../src/adapters/im/feishu.ts';
import { toFeishuMarkdown } from '../src/adapters/im/feishu-format.ts';

function adapter() {
  const a = new FeishuAdapter({ appId: 'cli_test', appSecret: 'x' }) as any;
  a.botOpenId = 'ou_bot';
  a.chatName = async () => 'dev';
  return a;
}
const event = (message: object, sender = 'ou_alice') => ({
  sender: { sender_type: 'user', sender_id: { open_id: sender } },
  message: { message_id: 'om_2', chat_id: 'oc_1', chat_type: 'group', ...message },
});

test('group text: bot mention detected and removed, other mentions spelled out, thread = root', async () => {
  const msg = await adapter().parse(
    event({
      message_type: 'text',
      root_id: 'om_1',
      content: JSON.stringify({ text: '@_user_1 ask @_user_2 about it' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'bridge' },
        { key: '@_user_2', id: { open_id: 'ou_bob' }, name: 'Bob' },
      ],
    }),
  );
  assert.deepEqual(
    { text: msg.text, mentioned: msg.mentioned, threadId: msg.threadId, isDM: msg.isDM, channelName: msg.channelName, userId: msg.userId },
    { text: 'ask @Bob about it', mentioned: true, threadId: 'om_1', isDM: false, channelName: 'dev', userId: 'ou_alice' },
  );
});

test('DM rich text with an image: text kept, image becomes a downloadable file', async () => {
  const msg = await adapter().parse(
    event({
      chat_type: 'p2p',
      message_type: 'post',
      content: JSON.stringify({
        title: 'Bug',
        content: [[{ tag: 'text', text: 'see ' }, { tag: 'a', text: 'log', href: 'https://x.dev/l' }], [{ tag: 'img', image_key: 'img_1' }]],
      }),
    }),
  );
  assert.equal(msg.isDM, true);
  assert.equal(msg.channelName, 'dm');
  assert.equal(msg.text, 'Bug\nsee [log](https://x.dev/l)');
  assert.deepEqual(msg.files.map((f: any) => f.name), ['img_1.png']);
  assert.equal(msg.threadId, 'om_2', 'a message without root starts its own thread');
});

test('file messages carry the file name; bots and stickers are ignored', async () => {
  const a = adapter();
  const f = await a.parse(event({ message_type: 'file', content: JSON.stringify({ file_key: 'fk', file_name: 'trace.log' }) }));
  assert.equal(f.files[0].name, 'trace.log');
  assert.equal(f.text, '');
  assert.equal(await a.parse({ ...event({ message_type: 'text', content: '{"text":"hi"}' }), sender: { sender_type: 'app' } }), undefined);
  assert.equal(await a.parse(event({ message_type: 'sticker', content: '{}' })), undefined);
});

test('cards: markdown body, buttons carry the choice value, outcome note replaces buttons', () => {
  const c = card('## Plan\n**go**', { choices: [{ label: 'Approve', value: 'abc|approve', style: 'primary' }, { label: 'Deny', value: 'abc|deny', style: 'danger' }] });
  assert.equal((c.elements[0] as any).content, '**Plan**\n**go**');
  assert.deepEqual((c.elements[1] as any).actions.map((b: any) => [b.text.content, b.type, b.value.v]), [
    ['Approve', 'primary', 'abc|approve'],
    ['Deny', 'danger', 'abc|deny'],
  ]);
  const done = card('## Plan', { note: '✅ Approved by alice.' });
  assert.equal(done.elements.length, 2);
  assert.equal((done.elements[1] as any).tag, 'note');
  assert.equal(c.config.update_multi, true, 'needed so the card can be edited for everyone');
});

test('feishu markdown: tables become records, code untouched', () => {
  assert.equal(
    toFeishuMarkdown('| 文件 | 作用 |\n|---|---|\n| `a.ts` | 路由<br>匹配 |\n\n```\n| not | a table |\n```'),
    '**a.ts**\n- 作用: \n    - 路由\n    - 匹配\n\n```\n| not | a table |\n```',
  );
});
