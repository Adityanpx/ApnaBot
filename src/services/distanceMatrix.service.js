const axios = require('axios');
const logger = require('../utils/logger');

const DISTANCE_MATRIX_BASE = 'https://maps.googleapis.com/maps/api/distancematrix/json';

/**
 * Get driving distance in km between two locations via Google Distance Matrix.
 * @param {string} origin
 * @param {string} destination
 * @returns {Promise<number|null>} distance in km, or null if it can't be computed
 */
const getDistanceKm = async (origin, destination) => {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    logger.error('GOOGLE_MAPS_API_KEY is not configured but a distance lookup was requested');
    return null;
  }

  try {
    const response = await axios.get(DISTANCE_MATRIX_BASE, {
      params: {
        origins: origin,
        destinations: destination,
        units: 'metric',
        key: process.env.GOOGLE_MAPS_API_KEY
      }
    });

    const element = response.data?.rows?.[0]?.elements?.[0];
    if (response.data.status !== 'OK' || !element || element.status !== 'OK') {
      return null;
    }

    return element.distance.value / 1000;
  } catch (error) {
    logger.error('Error calling Google Distance Matrix API:', error.response?.data || error.message);
    return null;
  }
};

module.exports = {
  getDistanceKm
};
