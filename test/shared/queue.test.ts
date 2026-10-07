import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskQueue } from "../../src/shared/queue.ts";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

test("并发 1 时任务按入队顺序串行执行", async () => {
  const queue = createTaskQueue(1);
  const order: number[] = [];
  const done1 = new Promise<void>((resolve) => {
    queue.push(async () => {
      order.push(1);
      await tick();
      await tick();
      order.push(2);
      resolve();
    });
  });
  const done2 = new Promise<void>((resolve) => {
    queue.push(async () => {
      order.push(3);
      resolve();
    });
  });
  await Promise.all([done1, done2]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("任务抛错不阻塞后续任务", async () => {
  const queue = createTaskQueue(2);
  let secondRan = false;
  queue.push(async () => {
    throw new Error("boom");
  });
  queue.push(async () => {
    secondRan = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondRan, true);
});

test("并发 2 时最多两个任务同时执行", async () => {
  const queue = createTaskQueue(2);
  const running: number[] = [];
  const peak = { value: 0 };
  const releaseFirst = new Promise<void>((resolve) => {
    queue.push(async () => {
      running.push(1);
      await new Promise((r) => setTimeout(r, 30));
      peak.value = Math.max(peak.value, running.length);
      running.splice(running.indexOf(1), 1);
      resolve();
    });
  });
  const doneSecond = new Promise<void>((resolve) => {
    queue.push(async () => {
      running.push(2);
      await new Promise((r) => setTimeout(r, 30));
      peak.value = Math.max(peak.value, running.length);
      running.splice(running.indexOf(2), 1);
      resolve();
    });
  });
  const doneThird = new Promise<void>((resolve) => {
    queue.push(async () => {
      running.push(3);
      peak.value = Math.max(peak.value, running.length);
      running.splice(running.indexOf(3), 1);
      resolve();
    });
  });
  await Promise.all([releaseFirst, doneSecond, doneThird]);
  // 前两个并行，第三个在前两者之一结束后才启动
  assert.equal(peak.value, 2);
});

test("并发 3 时三个任务可同时执行", async () => {
  const queue = createTaskQueue(3);
  const started: number[] = [];
  const gates = [0, 1, 2].map(() => new Promise<void>((resolve) => {
    queue.push(async () => {
      started.push(1);
      await new Promise((r) => setTimeout(r, 30));
      resolve();
    });
  }));
  await Promise.all(gates);
  assert.equal(started.length, 3);
});

test("pending 与 running 计数反映排队与完成", async () => {
  const queue = createTaskQueue(1);
  assert.equal(queue.pending, 0);
  assert.equal(queue.running, 0);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.push(async () => {
    await gate;
  });
  queue.push(async () => {});
  await tick();
  assert.equal(queue.pending, 2);
  assert.equal(queue.running, 1);
  release();
  await tick();
  await tick();
  assert.equal(queue.pending, 0);
  assert.equal(queue.running, 0);
});
