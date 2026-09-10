// Loaded only by the process-signal tests with node --import. Production does
// not import this module. Any unexpected AWS request fails without networking.
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { Readable } from 'node:stream';

const rows = new Map();
let release;
const released = new Promise(resolve => { release = resolve; });
process.on('message', message => { if (message?.type === 'release-model') release(); });

DynamoDBClient.prototype.send = async function (command) {
  const input = command.input;
  if (command.constructor.name === 'GetItemCommand') {
    return { Item: structuredClone(rows.get(input.Key.id.S)) };
  }
  if (command.constructor.name === 'TransactWriteItemsCommand') {
    // One test request exercises shutdown, not transaction conflict handling.
    // The dedicated admission suite covers the compare-and-swap semantics.
    for (const item of input.TransactItems) {
      if (!item.Update) throw new Error('Unexpected transaction member');
      const update = item.Update;
      const values = update.ExpressionAttributeValues;
      const row = { id: update.Key.id, v: values[':v'], data: values[':data'], expiresAt: values[':ttl'] };
      if (values[':requests']) row.requests = values[':requests'];
      rows.set(update.Key.id.S, row);
    }
    return {};
  }
  throw new Error('Unexpected AWS operation in signal fixture');
};

BedrockAgentCoreClient.prototype.send = async function (command) {
  if (command.constructor.name !== 'InvokeAgentRuntimeCommand') throw new Error('Unexpected runtime operation');
  process.send?.({ type: 'model-started' });
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  const response = Readable.from((async function* () {
    yield frame({ type: 'status', stage: 'thinking' });
    yield frame({ type: 'token', text: '진행 중 ' });
    await released;
    yield frame({ type: 'map', answer: '진행 중 답변 완료', markers: [], route: [], warnings: [] });
    yield frame({ type: 'done' });
  })());
  return { contentType: 'text/event-stream', response };
};
