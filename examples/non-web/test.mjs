import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from './calc.mjs';
test('加法既有业务行为', () => assert.equal(add(2, 3), 5));
