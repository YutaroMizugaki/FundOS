import assert from "node:assert/strict";
import { test } from "node:test";
import { SimulationClock } from "../src/clock.js";

test("one-shot task fires once at its scheduled time", () => {
  const clock = new SimulationClock(0);
  const fired: number[] = [];
  clock.at(100, (now) => fired.push(now));

  clock.advanceTo(50);
  assert.deepEqual(fired, []);
  clock.advanceTo(150);
  assert.deepEqual(fired, [100]);
  clock.advanceTo(300);
  assert.deepEqual(fired, [100]);
});

test("recurring task fires on every interval", () => {
  const clock = new SimulationClock(0);
  const fired: number[] = [];
  clock.every(10, (now) => fired.push(now));
  clock.advanceTo(35);
  assert.deepEqual(fired, [10, 20, 30]);
});

test("tasks fire in chronological order regardless of registration order", () => {
  const clock = new SimulationClock(0);
  const order: string[] = [];
  clock.at(30, () => order.push("c"));
  clock.at(10, () => order.push("a"));
  clock.at(20, () => order.push("b"));
  clock.advanceTo(100);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("cancelled tasks do not fire", () => {
  const clock = new SimulationClock(0);
  let count = 0;
  const handle = clock.every(10, () => count++);
  clock.advanceTo(15);
  handle.cancel();
  clock.advanceTo(100);
  assert.equal(count, 1);
});

test("advancing backwards throws", () => {
  const clock = new SimulationClock(100);
  assert.throws(() => clock.advanceTo(50), RangeError);
  assert.throws(() => clock.advance(-1), RangeError);
});
