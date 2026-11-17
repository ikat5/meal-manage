import test from 'node:test';
import assert from 'node:assert/strict';
import { approximateMealRate, calculateBalances, memberHistory } from '../public/model.js';

const empty = () => ({ members: [], deposits: [], groceries: [], meals: [] });
test('empty and zero-meal states do not divide by zero', () => {
  const result = calculateBalances(empty());
  assert.equal(result.rate, 0);
  assert.equal(result.cash, 0);
  const spendingOnly = calculateBalances({ ...empty(), groceries: [{ amount: 10000 }] });
  assert.equal(spendingOnly.rate, 0);
  assert.equal(spendingOnly.cash, -10000);
});

test('the supplied Rahim and Karim balances use total grocery cost / total meals', () => {
  const data = {
    members: [{ id: 1, name: 'Rahim' }, { id: 2, name: 'Karim' }],
    deposits: [{ memberId: 1, amount: 300000 }, { memberId: 2, amount: 200000 }],
    groceries: [{ amount: 522000 }],
    meals: Array.from({ length: 45 }, (_, index) => ({ attendees: [{ memberId: 2, guests: 0 }, ...(index < 42 ? [{ memberId: 1, guests: 0 }] : [])] })),
  };
  const result = calculateBalances(data);
  assert.equal(result.totalMeals, 87);
  assert.equal(result.rate, 6000);
  assert.equal(result.cash, -22000);
  assert.equal(result.rows[0].cost, 252000);
  assert.equal(result.rows[0].balance, 48000);
  assert.equal(result.rows[1].cost, 270000);
  assert.equal(result.rows[1].balance, -70000);
});

test('guests are charged to their host and rounding reconciles every paisa', () => {
  const result = calculateBalances({
    ...empty(), members: [{ id: 1, active: false }, { id: 2 }], groceries: [{ amount: 100 }],
    meals: [{ attendees: [{ memberId: 1, guests: 1 }, { memberId: 2, guests: 0 }] }],
  });
  assert.equal(result.totalMeals, 3);
  assert.equal(result.rows[0].meals, 2);
  assert.equal(result.rows[0].cost, 67);
  assert.equal(result.rows[1].cost, 33);
  assert.equal(result.rows.reduce((sum, row) => sum + row.cost, 0), 100);
});

test('history includes only the selected member and counts hosted guests', () => {
  const data = {
    ...empty(), deposits: [{ id: 1, memberId: 1, date: '2026-11-01', amount: 100 }, { id: 2, memberId: 2, date: '2026-11-03', amount: 500 }],
    meals: [{ id: 3, date: '2026-11-02', attendees: [{ memberId: 1, guests: 2 }] }],
  };
  const history = memberHistory(data, 1);
  assert.equal(history.length, 2);
  assert.equal(history[0].kind, 'meal');
  assert.equal(history[0].units, 3);
  assert.equal(history[1].kind, 'deposit');
});

test('approximate meal cost never changes any balance calculation', () => {
  const data = {
    members: [{ id: 1 }, { id: 2 }],
    deposits: [{ memberId: 1, amount: 300000, date: '2026-11-16' }], groceries: [{ amount: 60000 }],
    meals: [{ id: 1, date: '2026-11-17', attendees: [{ memberId: 1, guests: 1, quantity: 2 }, { memberId: 2, guests: 0, quantity: 1 }] }],
  };
  const expected = calculateBalances(data);
  for (const approximateCost of [null, 0, 6500, 9999999999]) {
    assert.deepEqual(calculateBalances({ ...data, meals: [{ ...data.meals[0], approximateCost }] }), expected);
  }
  assert.equal(expected.totalMeals, 4);
  assert.equal(expected.rows[0].cost, 45000);
  assert.equal(expected.rows[1].cost, 15000);
  assert.equal(memberHistory(data, 1)[0].units, 3);
});

test('approximate meal rate divides total cost by portions, including guests', () => {
  const meal = { approximateCost: 60000, attendees: [{ memberId: 1, quantity: 2, guests: 1 }, { memberId: 2, quantity: 1, guests: 0 }] };
  assert.equal(approximateMealRate(meal), 15000); // ৳600 / four portions = ৳150 per portion.
  assert.equal(approximateMealRate({ approximateCost: 100, attendees: [{ guests: 2 }] }), 100 / 3);
  assert.equal(approximateMealRate({ ...meal, approximateCost: 0 }), 0);
});

test('approximate meal rate is unset when cost or attendance is missing', () => {
  assert.equal(approximateMealRate({ attendees: [{ quantity: 1, guests: 0 }] }), null);
  assert.equal(approximateMealRate({ approximateCost: null, attendees: [{ quantity: 1, guests: 0 }] }), null);
  assert.equal(approximateMealRate({ approximateCost: 60000, attendees: [] }), null);
});

test('merging legacy attendance into one portion count preserves balances and history units', () => {
  const data = {
    members: [{ id: 1 }, { id: 2 }],
    deposits: [{ memberId: 1, amount: 100000, date: '2026-11-16' }], groceries: [{ amount: 43000 }],
    meals: [{ id: 1, date: '2026-11-17', approximateCost: 43000, attendees: [{ memberId: 1, quantity: 20, guests: 20 }, { memberId: 2, quantity: 1, guests: 2 }] }],
  };
  const normalized = {
    ...data,
    meals: data.meals.map((meal) => ({ ...meal, attendees: meal.attendees.map((person) => ({ ...person, quantity: person.quantity + person.guests, guests: 0 })) })),
  };
  assert.deepEqual(calculateBalances(normalized), calculateBalances(data));
  assert.equal(approximateMealRate(normalized.meals[0]), approximateMealRate(data.meals[0]));
  assert.equal(memberHistory(normalized, 1)[0].units, 40);
  assert.equal(memberHistory(normalized, 2)[0].units, 3);
});
