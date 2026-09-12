import assert from 'node:assert/strict';

/** Atomic Dynamo wire double shared by independently constructed SDK stores. */
export function admissionDynamo() {
  const rows = new Map();
  const commands = [];
  return {
    rows, commands,
    client() {
      return {
        async send(command, { abortSignal } = {}) {
          abortSignal?.throwIfAborted();
          commands.push(command);
          const input = command.input;
          if (command.constructor.name === 'GetItemCommand') {
            assert.equal(input.ConsistentRead, true);
            return { Item: structuredClone(rows.get(input.Key.id.S)) };
          }
          assert.equal(command.constructor.name, 'TransactWriteItemsCommand');
          const updates = input.TransactItems.map(item => {
            assert.deepEqual(Object.keys(item), ['Update']);
            return item.Update;
          });
          assert.equal(new Set(updates.map(update => update.Key.id.S)).size, updates.length);
          const reasons = updates.map(update => {
            const current = rows.get(update.Key.id.S);
            const values = update.ExpressionAttributeValues;
            const creating = update.ConditionExpression.startsWith('attribute_not_exists(#id)');
            let valid = creating ? current === undefined : current !== undefined
              && (current.v === undefined || current.v.N === values[':old'].N);
            if (!creating) assert.match(update.ConditionExpression, /#v = :old/);
            if (values[':previousRequests']) {
              assert.match(update.ConditionExpression, /#requests = :previousRequests/);
              valid &&= current?.requests?.N === values[':previousRequests'].N;
            } else if (values[':requests']) {
              assert.match(update.ConditionExpression, /attribute_not_exists\(#requests\)/);
              valid &&= current?.requests === undefined;
            }
            return { Code: valid ? 'None' : 'ConditionalCheckFailed' };
          });
          if (reasons.some(reason => reason.Code !== 'None')) {
            throw Object.assign(new Error('conditional transaction rejected'), {
              name: 'TransactionCanceledException', CancellationReasons: reasons,
            });
          }
          // Check every member before publishing any, with no await in between.
          for (const update of updates) {
            const values = update.ExpressionAttributeValues;
            rows.set(update.Key.id.S, structuredClone({
              id: update.Key.id, v: values[':v'], data: values[':data'], expiresAt: values[':ttl'],
              ...(values[':requests'] ? { requests: values[':requests'] } : {}),
            }));
          }
          return {};
        },
      };
    },
  };
}
