export const slots = ['breakfast', 'lunch', 'dinner'];

export const mealPortions = (person) => (person.quantity ?? 1) + person.guests;

export function approximateMealRate(meal) {
  const portions = meal.attendees.reduce((sum, person) => sum + mealPortions(person), 0);
  return meal.approximateCost == null || !portions ? null : meal.approximateCost / portions;
}

export function calculateBalances(data) {
  const deposited = data.deposits.reduce((sum, entry) => sum + entry.amount, 0);
  const spent = data.groceries.reduce((sum, entry) => sum + entry.amount, 0);
  const units = new Map(data.members.map((member) => [member.id, 0]));
  for (const meal of data.meals) {
    for (const person of meal.attendees) {
      units.set(person.memberId, (units.get(person.memberId) || 0) + mealPortions(person));
    }
  }
  const totalMeals = [...units.values()].reduce((sum, count) => sum + count, 0);
  const rate = totalMeals ? spent / totalMeals : 0;
  const rows = data.members.map((member) => {
    const meals = units.get(member.id) || 0;
    const exactCost = meals * rate;
    return {
      ...member,
      deposited: data.deposits.filter((entry) => entry.memberId === member.id)
        .reduce((sum, entry) => sum + entry.amount, 0),
      meals,
      cost: Math.floor(exactCost),
      remainder: exactCost - Math.floor(exactCost),
    };
  });
  // Allocate rounding paisa deterministically so member costs equal grocery spending.
  let remaining = totalMeals ? spent - rows.reduce((sum, row) => sum + row.cost, 0) : 0;
  for (const row of [...rows].sort((a, b) => b.remainder - a.remainder || a.id - b.id)) {
    if (remaining-- > 0) row.cost += 1;
  }
  return {
    deposited, spent, totalMeals, rate, cash: deposited - spent,
    rows: rows.map((row) => ({ ...row, balance: row.deposited - row.cost })),
  };
}

export function memberHistory(data, memberId) {
  return [
    ...data.deposits.filter((entry) => entry.memberId === memberId)
      .map((entry) => ({ ...entry, kind: 'deposit' })),
    ...data.meals.filter((meal) => meal.attendees.some((person) => person.memberId === memberId))
      .map((meal) => ({ ...meal, kind: 'meal', units: mealPortions(meal.attendees.find((person) => person.memberId === memberId)) })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}
