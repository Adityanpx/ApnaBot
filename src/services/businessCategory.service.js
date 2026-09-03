const supabase = require('../config/supabase');
const { toCamelCase } = require('../utils/caseConvert');
const logger = require('../utils/logger');

/**
 * All business_categories rows, ordered for display (SuperAdmin category
 * management + categoryTemplate.controller.js's isKnownCategory check).
 */
const getAllCategories = async () => {
  try {
    const { data, error } = await supabase
      .from('business_categories')
      .select('*')
      .order('display_order', { ascending: true });
    if (error) throw error;

    return (data || []).map(toCamelCase);
  } catch (error) {
    logger.error('Error in getAllCategories:', error);
    throw error;
  }
};

/**
 * Categories currently offered at signup (business.controller.js#createBusiness
 * validation source, and the public /api/business-categories endpoint).
 */
const getEnabledCategories = async () => {
  try {
    const { data, error } = await supabase
      .from('business_categories')
      .select('*')
      .eq('is_enabled', true)
      .order('display_order', { ascending: true });
    if (error) throw error;

    return (data || []).map(toCamelCase);
  } catch (error) {
    logger.error('Error in getEnabledCategories:', error);
    throw error;
  }
};

/**
 * True only if value exists AND is enabled — used to gate business creation.
 */
const isEnabledCategory = async (value) => {
  try {
    const { data, error } = await supabase
      .from('business_categories')
      .select('value')
      .eq('value', value)
      .eq('is_enabled', true)
      .maybeSingle();
    if (error) throw error;

    return !!data;
  } catch (error) {
    logger.error('Error in isEnabledCategory:', error);
    throw error;
  }
};

/**
 * True if value exists at all, enabled or not — used by category-template
 * cloning, where SuperAdmin should be able to build a template for a
 * category before turning it on for signup.
 */
const isKnownCategory = async (value) => {
  try {
    const { data, error } = await supabase
      .from('business_categories')
      .select('value')
      .eq('value', value)
      .maybeSingle();
    if (error) throw error;

    return !!data;
  } catch (error) {
    logger.error('Error in isKnownCategory:', error);
    throw error;
  }
};

/**
 * SuperAdmin toggle — enable/disable a category for signup without touching
 * the CHECK constraints or code.
 */
const setCategoryEnabled = async (value, isEnabled) => {
  try {
    const { data, error } = await supabase
      .from('business_categories')
      .update({ is_enabled: isEnabled, updated_at: new Date().toISOString() })
      .eq('value', value)
      .select('*')
      .single();
    if (error) throw error;

    return toCamelCase(data);
  } catch (error) {
    logger.error('Error in setCategoryEnabled:', error);
    throw error;
  }
};

module.exports = {
  getAllCategories,
  getEnabledCategories,
  isEnabledCategory,
  isKnownCategory,
  setCategoryEnabled
};
