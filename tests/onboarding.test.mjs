import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promptTerminal } from '../src/onboarding.mjs';

function terminal({ initiallyRaw = false, inputText }) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = initiallyRaw;
  input.setRawMode = raw => { input.isRaw = raw; };
  input.resume = () => {};
  input.pause = () => {};
  const displayed = [];
  const output = {
    isTTY: true,
    write(text) {
      displayed.push(text);
      if (text === 'Token: ') {
        assert.equal(input.isRaw, true, 'echo must already be disabled when the prompt becomes visible');
        queueMicrotask(() => input.emit('data', Buffer.from(inputText)));
      }
    },
  };
  return { input, output, displayed };
}

test('secret prompt is ready for an immediate paste before becoming visible and restores terminal mode', async () => {
  for (const initiallyRaw of [false, true]) {
    const fixture = terminal({ initiallyRaw, inputText: 'private-fixture-token\r' });
    const value = await promptTerminal('Token: ', { secret: true, ...fixture });
    assert.equal(value, 'private-fixture-token');
    assert.deepEqual(fixture.displayed, ['Token: ', '\n']);
    assert.equal(fixture.input.isRaw, initiallyRaw);
    assert.equal(fixture.input.listenerCount('data'), 0);
  }
});

test('canceling a secret prompt restores terminal mode without displaying partial input', async () => {
  const fixture = terminal({ inputText: 'partial-private-fixture\x03' });
  await assert.rejects(promptTerminal('Token: ', { secret: true, ...fixture }), /Setup canceled/);
  assert.deepEqual(fixture.displayed, ['Token: ', '\n']);
  assert.equal(fixture.input.isRaw, false);
  assert.equal(fixture.input.listenerCount('data'), 0);
});
