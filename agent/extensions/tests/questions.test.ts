import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { AskUserQuestionComponent } from "../ask-user-question/component.ts";

const theme = { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s } as Theme;
const options = [{ label: "Yes" }, { label: "No" }];
const keys = { down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", backspace: "\x7f", escape: "\x1b" };
function form(multiSelect = false) {
  const results: any[] = [];
  const questions = [1, 2].map(n => ({ question: `Question ${n}`, header: `Q${n}`, options, multiSelect: n === 1 && multiSelect }));
  const component = new AskUserQuestionComponent(questions, { requestRender() {}, terminal: { rows: 24 } }, theme, result => results.push(result));
  return { component, results, press: (...input: string[]) => input.forEach(key => component.handleInput(key)) };
}

test("clearing confirmed free text prevents submission until it is replaced", () => {
  for (const multi of [false, true]) {
    const { press, results } = form(multi);
    press(keys.down, keys.down, " ", "x", keys.enter);
    if (multi) press(keys.enter);
    press(keys.left, " ", keys.backspace, keys.enter); // Revisit and clear Q1.
    press(keys.right, keys.enter, keys.enter); // Answer Q2 and attempt Submit.
    assert.equal(results.length, 0);
    press(keys.right, " ", "replacement", keys.enter);
    if (multi) press(keys.enter);
    press(keys.right, keys.enter);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].answers, { "Question 1": "replacement", "Question 2": "Yes" });
  }
});

test("removing optional free text keeps selected multi-select options", () => {
  const { press, results } = form(true);
  press(" ", keys.down, keys.down, " ", "x", keys.enter, keys.enter);
  press(keys.left, " ", keys.backspace, keys.enter);
  press(keys.right, keys.enter, keys.enter);
  assert.deepEqual(results[0].answers, { "Question 1": "Yes", "Question 2": "Yes" });
});

test("cancelling an edit preserves a confirmed answer, and Escape can cancel the form", () => {
  const { press, results } = form();
  press(keys.down, keys.down, " ", "x", keys.enter);
  press(keys.left, " ", keys.backspace, keys.escape);
  press(keys.right, keys.enter, keys.enter);
  assert.equal(results[0].answers["Question 1"], "x");
  const cancelled = form();
  cancelled.press(keys.escape, keys.enter);
  assert.deepEqual(cancelled.results, [null]);
});

test("submit checks actual answers even if confirmation state is stale", () => {
  const { component, results } = form();
  // Simulate stale state independently of the clear-answer handler.
  const internal = component as any;
  internal.states.forEach((state: any) => { state.confirmed = true; });
  internal.submit();
  assert.equal(results.length, 0);
});
