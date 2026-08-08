require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
const SHOP_ID = process.env.SHOP_ID || '6a75860c2d1149c0d6cf195f';

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const Plan = mongoose.connection.collection('plans');
  const Subscription = mongoose.connection.collection('subscriptions');

  // 1. Find any active plan, preferring one with payment links enabled (for the pay rule)
  let plan = await Plan.findOne({ isActive: true }, { sort: { price: -1 } });

  if (!plan) {
    const res = await Plan.insertOne({
      name: 'test-unlimited',
      displayName: 'Test Unlimited',
      price: 0,
      msgLimit: -1,
      ruleLimit: -1,
      customerLimit: -1,
      bookingEnabled: true,
      paymentLinkEnabled: true,
      staffEnabled: true,
      maxStaff: 10,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    plan = await Plan.findOne({ _id: res.insertedId });
    console.log(`Created plan "${plan.displayName}" (${plan._id}).`);
  } else {
    console.log(`Using existing plan "${plan.displayName}" (${plan._id}).`);
  }

  // 2. Upsert an active subscription for the shop
  const now = new Date();
  const oneYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  await Subscription.updateOne(
    { shopId: new mongoose.Types.ObjectId(SHOP_ID) },
    {
      $set: {
        planId: plan._id,
        status: 'active',
        startDate: now,
        endDate: oneYear,
        autoRenew: true,
        updatedAt: now,
      },
      $setOnInsert: {
        shopId: new mongoose.Types.ObjectId(SHOP_ID),
        razorpaySubscriptionId: null,
        razorpayPaymentId: null,
        createdAt: now,
      },
    },
    { upsert: true }
  );

  console.log(`Active subscription set for shop ${SHOP_ID}, expires ${oneYear.toISOString()}.`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error('Failed:', e); process.exit(1); });