require('dotenv').config();
const logger = require('../utils/logger');
const seedPlans = require('./planSeed');
const seedAdmin = require('./adminSeed');

const runSeeds = async () => {
  try {
    logger.info('Starting database seeding...');

    await seedPlans();
    await seedAdmin();
    
    logger.info('All seeds completed successfully!');
    process.exit(0);
  } catch (error) {
    logger.error('Error running seeds:', error);
    process.exit(1);
  }
};

runSeeds();
