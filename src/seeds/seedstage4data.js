// src/seeds/testDataSeed.js
// Seeds realistic test data for Stage 4 testing
// Run: node src/seeds/testDataSeed.js

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Customer = require('../models/Customer');
const Message = require('../models/Message');
const Booking = require('../models/Booking');
const logger = require('../utils/logger');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SHOP_ID = '69c0baefff5acc5c25caffd9';
const OWNER_USER_ID = '69c0b645572dbf0205e1cd0a';

// ─── CUSTOMERS ───────────────────────────────────────────────────────────────
const customers = [
  {
    shopId: SHOP_ID,
    whatsappNumber: '919822111001',
    name: 'Amit Kumar',
    firstSeenAt: new Date('2026-03-20T10:00:00Z'),
    lastMessageAt: new Date('2026-03-23T08:00:00Z'),
    totalMessages: 6,
    tags: ['vip', 'regular'],
    notes: 'Prefers evening appointments. Usually orders suits.',
    isBlocked: false
  },
  {
    shopId: SHOP_ID,
    whatsappNumber: '919822111002',
    name: 'Priya Sharma',
    firstSeenAt: new Date('2026-03-21T11:00:00Z'),
    lastMessageAt: new Date('2026-03-23T09:00:00Z'),
    totalMessages: 4,
    tags: ['new'],
    notes: 'Interested in blouses and salwar suits.',
    isBlocked: false
  },
  {
    shopId: SHOP_ID,
    whatsappNumber: '919822111003',
    name: 'Ravi Patil',
    firstSeenAt: new Date('2026-03-22T09:00:00Z'),
    lastMessageAt: new Date('2026-03-22T09:30:00Z'),
    totalMessages: 2,
    tags: [],
    notes: '',
    isBlocked: false
  },
  {
    shopId: SHOP_ID,
    whatsappNumber: '919822111004',
    name: 'Sunita Desai',
    firstSeenAt: new Date('2026-03-22T14:00:00Z'),
    lastMessageAt: new Date('2026-03-23T07:00:00Z'),
    totalMessages: 5,
    tags: ['regular'],
    notes: 'Always pays on time.',
    isBlocked: false
  },
  {
    shopId: SHOP_ID,
    whatsappNumber: '919822111005',
    name: 'Blocked Customer',
    firstSeenAt: new Date('2026-03-19T10:00:00Z'),
    lastMessageAt: new Date('2026-03-19T10:05:00Z'),
    totalMessages: 1,
    tags: ['spam'],
    notes: 'Blocked for spamming.',
    isBlocked: true
  }
];

// ─── SEED FUNCTION ────────────────────────────────────────────────────────────
const seedTestData = async () => {
  try {
    await connectDB();
    logger.info('Connected to DB. Starting test data seed...');

    // ── Clean existing test data ──────────────────────────────────────────────
    logger.info('Cleaning existing test data for this shop...');
    await Customer.deleteMany({ shopId: SHOP_ID });
    await Message.deleteMany({ shopId: SHOP_ID });
    await Booking.deleteMany({ shopId: SHOP_ID });
    logger.info('Existing test data cleaned.');

    // ── Create Customers ──────────────────────────────────────────────────────
    logger.info('Creating customers...');
    const createdCustomers = await Customer.insertMany(customers);
    logger.info(`Created ${createdCustomers.length} customers.`);

    const c1 = createdCustomers[0]; // Amit Kumar
    const c2 = createdCustomers[1]; // Priya Sharma
    const c3 = createdCustomers[2]; // Ravi Patil
    const c4 = createdCustomers[3]; // Sunita Desai

    // ── Create Messages ───────────────────────────────────────────────────────
    logger.info('Creating messages...');

    const messages = [

      // ── Amit Kumar conversation ──
      {
        shopId: SHOP_ID,
        customerId: c1._id,
        customerNumber: c1.whatsappNumber,
        direction: 'inbound',
        type: 'text',
        content: 'Hello',
        metaMessageId: 'meta_msg_001',
        status: 'delivered',
        isRead: true,
        createdAt: new Date('2026-03-23T08:00:00Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c1._id,
        customerNumber: c1.whatsappNumber,
        direction: 'outbound',
        type: 'text',
        content: 'Hi! Welcome to Rahul Tailor. Type price for rates, book to book, or pay to make payment.',
        status: 'delivered',
        isRead: true,
        createdAt: new Date('2026-03-23T08:00:05Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c1._id,
        customerNumber: c1.whatsappNumber,
        direction: 'inbound',
        type: 'text',
        content: 'price',
        metaMessageId: 'meta_msg_002',
        status: 'delivered',
        isRead: true,
        createdAt: new Date('2026-03-23T08:01:00Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c1._id,
        customerNumber: c1.whatsappNumber,
        direction: 'outbound',
        type: 'text',
        content: 'Our stitching prices start from ₹200 for shirts and ₹300 for suits. Send your measurements and we will give you an exact quote!',
        status: 'delivered',
        isRead: true,
        createdAt: new Date('2026-03-23T08:01:05Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c1._id,
        customerNumber: c1.whatsappNumber,
        direction: 'inbound',
        type: 'text',
        content: 'book',
        metaMessageId: 'meta_msg_003',
        status: 'delivered',
        isRead: false,
        createdAt: new Date('2026-03-23T08:05:00Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c1._id,
        customerNumber: c1.whatsappNumber,
        direction: 'outbound',
        type: 'text',
        content: 'Sure! Let me collect your booking details. What is your name?',
        status: 'sent',
        isRead: true,
        createdAt: new Date('2026-03-23T08:05:05Z')
      },

      // ── Priya Sharma conversation ──
      {
        shopId: SHOP_ID,
        customerId: c2._id,
        customerNumber: c2.whatsappNumber,
        direction: 'inbound',
        type: 'text',
        content: 'Hi, what are your timings?',
        metaMessageId: 'meta_msg_004',
        status: 'delivered',
        isRead: true,
        createdAt: new Date('2026-03-23T09:00:00Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c2._id,
        customerNumber: c2.whatsappNumber,
        direction: 'outbound',
        type: 'text',
        content: 'We are open Monday to Saturday, 10am to 8pm. Sunday by appointment only.',
        status: 'delivered',
        isRead: true,
        createdAt: new Date('2026-03-23T09:00:05Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c2._id,
        customerNumber: c2.whatsappNumber,
        direction: 'inbound',
        type: 'text',
        content: 'I want to book an appointment',
        metaMessageId: 'meta_msg_005',
        status: 'delivered',
        isRead: false,
        createdAt: new Date('2026-03-23T09:05:00Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c2._id,
        customerNumber: c2.whatsappNumber,
        direction: 'outbound',
        type: 'text',
        content: 'Sure! Let me collect your booking details. What is your name?',
        status: 'sent',
        isRead: true,
        createdAt: new Date('2026-03-23T09:05:05Z')
      },

      // ── Ravi Patil conversation ──
      {
        shopId: SHOP_ID,
        customerId: c3._id,
        customerNumber: c3.whatsappNumber,
        direction: 'inbound',
        type: 'text',
        content: 'order status for my kurta',
        metaMessageId: 'meta_msg_006',
        status: 'delivered',
        isRead: true,
        createdAt: new Date('2026-03-22T09:00:00Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c3._id,
        customerNumber: c3.whatsappNumber,
        direction: 'outbound',
        type: 'text',
        content: 'To check your order status, please share your order number or the date you gave us your clothes.',
        status: 'delivered',
        isRead: true,
        createdAt: new Date('2026-03-22T09:00:05Z')
      },

      // ── Sunita Desai conversation ──
      {
        shopId: SHOP_ID,
        customerId: c4._id,
        customerNumber: c4.whatsappNumber,
        direction: 'inbound',
        type: 'text',
        content: 'Hello, I need to pay for my order',
        metaMessageId: 'meta_msg_007',
        status: 'delivered',
        isRead: true,
        createdAt: new Date('2026-03-23T07:00:00Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c4._id,
        customerNumber: c4.whatsappNumber,
        direction: 'outbound',
        type: 'text',
        content: 'Here is your payment link. Please complete payment to confirm your booking.\n\nPay here: upi://pay?pa=rahul@okaxis&pn=Rahul+Tailor&tn=Payment',
        status: 'delivered',
        isRead: true,
        createdAt: new Date('2026-03-23T07:00:10Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c4._id,
        customerNumber: c4.whatsappNumber,
        direction: 'inbound',
        type: 'text',
        content: 'Done, paid via UPI',
        metaMessageId: 'meta_msg_008',
        status: 'delivered',
        isRead: false,
        createdAt: new Date('2026-03-23T07:10:00Z')
      }
    ];

    const createdMessages = await Message.insertMany(messages);
    logger.info(`Created ${createdMessages.length} messages.`);

    // ── Create Bookings ───────────────────────────────────────────────────────
    logger.info('Creating bookings...');

    const bookings = [
      {
        shopId: SHOP_ID,
        customerId: c1._id,
        customerNumber: c1.whatsappNumber,
        status: 'pending',
        fields: {
          customerName: 'Amit Kumar',
          service: 'Suit stitching',
          measurement: '38 chest, 32 waist',
          deliveryDate: '2026-04-01'
        },
        paymentStatus: 'not_required',
        createdAt: new Date('2026-03-23T08:10:00Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c2._id,
        customerNumber: c2.whatsappNumber,
        status: 'confirmed',
        fields: {
          customerName: 'Priya Sharma',
          service: 'Blouse stitching',
          measurement: 'Will visit in person',
          deliveryDate: '2026-03-28'
        },
        paymentStatus: 'not_required',
        createdAt: new Date('2026-03-22T11:00:00Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c4._id,
        customerNumber: c4.whatsappNumber,
        status: 'completed',
        fields: {
          customerName: 'Sunita Desai',
          service: 'Salwar suit stitching',
          measurement: '36 chest, 28 waist',
          deliveryDate: '2026-03-20'
        },
        paymentStatus: 'paid',
        paymentAmount: 800,
        createdAt: new Date('2026-03-15T10:00:00Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c3._id,
        customerNumber: c3.whatsappNumber,
        status: 'cancelled',
        fields: {
          customerName: 'Ravi Patil',
          service: 'Kurta stitching',
          measurement: '40 chest',
          deliveryDate: '2026-03-25'
        },
        paymentStatus: 'not_required',
        createdAt: new Date('2026-03-21T09:00:00Z')
      },
      {
        shopId: SHOP_ID,
        customerId: c1._id,
        customerNumber: c1.whatsappNumber,
        status: 'pending',
        fields: {
          customerName: 'Amit Kumar',
          service: 'Shirt stitching x3',
          measurement: '38 chest, 32 waist',
          deliveryDate: '2026-04-05',
          internalNotes: 'Rush order. Customer needs before Eid.'
        },
        paymentStatus: 'pending',
        paymentAmount: 600,
        createdAt: new Date('2026-03-23T08:30:00Z')
      }
    ];

    const createdBookings = await Booking.insertMany(bookings);
    logger.info(`Created ${createdBookings.length} bookings.`);

    // ── Summary ───────────────────────────────────────────────────────────────
    logger.info('');
    logger.info('════════════════════════════════════════');
    logger.info('✅ TEST DATA SEEDED SUCCESSFULLY');
    logger.info('════════════════════════════════════════');
    logger.info(`Customers : ${createdCustomers.length}`);
    logger.info(`Messages  : ${createdMessages.length}`);
    logger.info(`Bookings  : ${createdBookings.length}`);
    logger.info('');
    logger.info('Customer IDs:');
    createdCustomers.forEach(c => logger.info(`  ${c.name} (${c.whatsappNumber}) → ${c._id}`));
    logger.info('');
    logger.info('Booking IDs:');
    createdBookings.forEach(b => logger.info(`  [${b.status}] ${b.fields.customerName} → ${b._id}`));
    logger.info('════════════════════════════════════════');

    process.exit(0);
  } catch (error) {
    logger.error('Test data seeding error:', error);
    process.exit(1);
  }
};

seedTestData();