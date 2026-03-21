require('dotenv').config();
const connectDB = require('../config/db');
const logger = require('../utils/logger');
const seedPlans = require('./planSeed');
const seedBusinessTypeTemplates = require('./businessTypeSeed');
const seedAdmin = require('./adminSeed');

const runSeeds = async () => {
  try {
    logger.info('Starting database seeding...');
    
    await connectDB();
    logger.info('Database connected');
    
    await seedPlans();
    await seedBusinessTypeTemplates();
    await seedAdmin();
    
    logger.info('All seeds completed successfully!');
    process.exit(0);
  } catch (error) {
    logger.error('Error running seeds:', error);
    process.exit(1);
  }
};

runSeeds();
