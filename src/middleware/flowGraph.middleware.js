const supabase = require('../config/supabase');
const { errorResponse } = require('../utils/response');

/**
 * Gates every flow-graph CRUD route on businesses.booking_engine === 'graph'
 * (see 20260829190000_businesses_booking_engine.sql — replaces "does this
 * business have any flow_nodes rows" inference). Attaches req.graphBusiness
 * so handlers don't each re-query business_category/servedCities/
 * disabledBookingFields, which the reserved-field-key guard, the
 * servedCities-options guard, and the disabledBookingFields overlay all
 * separately need.
 */
const requireGraphEngine = async (req, res, next) => {
  try {
    const businessId = req.user.businessId;

    const { data: business, error } = await supabase
      .from('businesses')
      .select('booking_engine, business_category, served_cities, disabled_booking_fields')
      .eq('id', businessId)
      .maybeSingle();
    if (error) throw error;
    if (!business) {
      return errorResponse(res, 404, 'Business not found');
    }

    if (business.booking_engine !== 'graph') {
      return errorResponse(res, 400, 'This business is not on the graph booking engine yet.');
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
