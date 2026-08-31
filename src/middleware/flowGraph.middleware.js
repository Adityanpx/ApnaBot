const supabase = require('../config/supabase');
const { errorResponse } = require('../utils/response');

/**
 * Every business is on the graph booking engine now, so this no longer gates
 * on businesses.booking_engine (kept as a no-op rather than removed outright
 * — full removal, alongside dropping the column itself, happens in the later
 * DB-migration cleanup step). Still attaches req.graphBusiness so handlers
 * don't each re-query business_category/servedCities/disabledBookingFields,
 * which the reserved-field-key guard, the servedCities-options guard, and
 * the disabledBookingFields overlay all separately need.
 */
const requireGraphEngine = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data: business, error } = await supabase
      .from('businesses')
      .select('business_category, served_cities, disabled_booking_fields')
      .eq('id', businessId)
      .maybeSingle();
    if (error) throw error;
    if (!business) {
      return errorResponse(res, 404, 'Business not found');
    }

    req.graphBusiness = {
      businessCategory: business.business_category,
      servedCities: business.served_cities || [],
      disabledBookingFields: business.disabled_booking_fields || []
    };

    next();
  } catch (error) {
    next(error);
  }
};

module.exports = { requireGraphEngine };
