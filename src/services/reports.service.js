const supabase = require('../config/supabase');

const CONFIRMED_STATUSES = ['confirmed', 'completed'];

/**
 * Returns {currentStart, currentEnd, previousStart, previousEnd} for a
 * reports period. "week" is a rolling last-7-days window vs. the preceding
 * 7 days. "month" is calendar-month-to-date vs. the same elapsed duration
 * into the previous calendar month (not the previous month's full total) —
 * this keeps the comparison duration-matched rather than penalizing early-
 * month lookups against a full prior month.
 */
const getPeriodRanges = (period) => {
  const now = new Date();

  if (period === 'week') {
    const currentStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const previousStart = new Date(currentStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { currentStart, currentEnd: now, previousStart, previousEnd: currentStart };
  }

  // month
  const currentStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const elapsedMs = now.getTime() - currentStart.getTime();
  const previousStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
  const previousEnd = new Date(previousStart.getTime() + elapsedMs);
  return { currentStart, currentEnd: now, previousStart, previousEnd };
};

const countInRange = async (table, businessId, start, end, statusIn) => {
  let query = supabase.from(table).select('*', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString());
  if (statusIn) query = query.in('status', statusIn);
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
};

const sumFareInRange = async (businessId, start, end) => {
  const { data, error } = await supabase.from('bookings').select('fare_amount')
    .eq('business_id', businessId)
    .in('status', CONFIRMED_STATUSES)
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString());
  if (error) throw error;
  return (data || []).reduce((sum, row) => sum + (Number(row.fare_amount) || 0), 0);
};

const computeRangeStats = async (businessId, start, end) => {
  const [leads, bookingsConfirmed, revenue] = await Promise.all([
    countInRange('booking_leads', businessId, start, end),
    countInRange('bookings', businessId, start, end, CONFIRMED_STATUSES),
    sumFareInRange(businessId, start, end)
  ]);
  const conversionRate = leads === 0 ? 0 : bookingsConfirmed / leads;
  return { leads, bookingsConfirmed, revenue, conversionRate };
};

const growthPercent = (current, previous) =>
  previous === 0 ? null : ((current - previous) / previous) * 100;

const getReportsSummary = async (businessId, period) => {
  const { currentStart, currentEnd, previousStart, previousEnd } = getPeriodRanges(period);

  const [current, previous] = await Promise.all([
    computeRangeStats(businessId, currentStart, currentEnd),
    computeRangeStats(businessId, previousStart, previousEnd)
  ]);

  return {
    current,
    previous,
    growth: {
      leads: growthPercent(current.leads, previous.leads),
      bookingsConfirmed: growthPercent(current.bookingsConfirmed, previous.bookingsConfirmed),
      revenue: growthPercent(current.revenue, previous.revenue),
      conversionRate: growthPercent(current.conversionRate, previous.conversionRate)
    }
  };
};

module.exports = {
  getReportsSummary
};
