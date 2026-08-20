/**
 * Shallow snake_case -> camelCase key conversion for Supabase rows, so
 * internal callers written against the old Mongoose (camelCase) field names
 * keep working unchanged, and API responses preserve the existing camelCase
 * wire contract clients already depend on.
 */
const toCamelCase = (row) => {
  if (row === null || row === undefined) return row;
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    result[camelKey] = value;
  }
  if (result.id !== undefined && result._id === undefined) {
    result._id = result.id;
  }
  return result;
};

module.exports = { toCamelCase };
