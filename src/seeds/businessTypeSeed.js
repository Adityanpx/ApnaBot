// src/seeds/businessTypeSeed.js — REPLACE ENTIRE FILE

const BusinessTypeTemplate = require('../models/BusinessTypeTemplate');
const logger = require('../utils/logger');

const templates = [
  {
    businessType: 'tailor',
    defaultRules: [
      { keyword: 'price', matchType: 'contains', reply: 'Our stitching prices start from ₹200 for shirts and ₹300 for suits. Send your measurements and we will give you an exact quote!', replyType: 'text' },
      { keyword: 'timing', matchType: 'contains', reply: 'We are open Monday to Saturday, 10am to 8pm. Sunday by appointment only.', replyType: 'text' },
      { keyword: 'order', matchType: 'contains', reply: 'To check your order status, please share your order number or the date you gave us your clothes.', replyType: 'text' },
      { keyword: 'book', matchType: 'contains', reply: 'Sure! Let me take your booking details.', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'service', label: 'What service do you need? (shirt, suit, blouse, etc.)', required: true, order: 2 },
      { fieldKey: 'measurement', label: 'Please share your measurements or say "will visit in person"', required: false, order: 3 },
      { fieldKey: 'deliveryDate', label: 'When do you need it by?', required: true, order: 4 }
    ]
  },
  {
    businessType: 'salon',
    defaultRules: [
      { keyword: 'price', matchType: 'contains', reply: 'Haircut starts at ₹150, facial from ₹299, full package from ₹799. DM for full price list!', replyType: 'text' },
      { keyword: 'timing', matchType: 'contains', reply: 'We are open every day from 9am to 9pm including Sundays!', replyType: 'text' },
      { keyword: 'appointment', matchType: 'contains', reply: 'Let me book an appointment for you!', replyType: 'booking_trigger' },
      { keyword: 'book', matchType: 'contains', reply: 'Let me book an appointment for you!', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'service', label: 'Which service do you need? (haircut, facial, waxing, etc.)', required: true, order: 2 },
      { fieldKey: 'preferredTime', label: 'What date and time works for you?', required: true, order: 3 }
    ]
  },
  {
    businessType: 'garage',
    defaultRules: [
      { keyword: 'price', matchType: 'contains', reply: 'Service charges: General service ₹799, AC service ₹499, Denting/Painting quote on inspection. Call us for more details!', replyType: 'text' },
      { keyword: 'timing', matchType: 'contains', reply: 'We are open Monday to Saturday 8am to 7pm. Emergency breakdown service available.', replyType: 'text' },
      { keyword: 'book', matchType: 'contains', reply: 'Let me book your vehicle service!', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'vehicleNumber', label: 'What is your vehicle number?', required: true, order: 2 },
      { fieldKey: 'issue', label: 'What issue is your vehicle facing?', required: true, order: 3 },
      { fieldKey: 'date', label: 'When would you like to bring it in?', required: true, order: 4 }
    ]
  },
  {
    businessType: 'cab',
    defaultRules: [
      { keyword: 'price', matchType: 'contains', reply: 'Local rates: ₹12/km. Outstation: ₹14/km. Airport drop flat ₹499. Share pickup and drop for exact fare!', replyType: 'text' },
      { keyword: 'available', matchType: 'contains', reply: 'Yes we have cabs available! Share your pickup location and time for booking.', replyType: 'text' },
      { keyword: 'book', matchType: 'contains', reply: 'Let me book a cab for you!', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'pickup', label: 'Where do you want to be picked up from?', required: true, order: 2 },
      { fieldKey: 'drop', label: 'Where is your destination?', required: true, order: 3 },
      { fieldKey: 'date', label: 'What date do you need the cab?', required: true, order: 4 },
      { fieldKey: 'time', label: 'What time should we pick you up?', required: true, order: 5 }
    ]
  },
  {
    businessType: 'coaching',
    defaultRules: [
      { keyword: 'fee', matchType: 'contains', reply: 'Monthly fees: Class 9-10: ₹1500/month, Class 11-12: ₹2000/month. Includes study material!', replyType: 'text' },
      { keyword: 'schedule', matchType: 'contains', reply: 'Morning batch: 7am-9am. Evening batch: 5pm-7pm. Weekend special batch also available.', replyType: 'text' },
      { keyword: 'enroll', matchType: 'contains', reply: 'Great! Let me collect your enrollment details.', replyType: 'booking_trigger' },
      { keyword: 'admission', matchType: 'contains', reply: 'Great! Let me collect your enrollment details.', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is the student\'s name?', required: true, order: 1 },
      { fieldKey: 'class', label: 'Which class/standard?', required: true, order: 2 },
      { fieldKey: 'batch', label: 'Morning or Evening batch?', required: true, order: 3 },
      { fieldKey: 'phone', label: 'Parent\'s contact number?', required: true, order: 4 }
    ]
  },
  {
    businessType: 'gym',
    defaultRules: [
      { keyword: 'price', matchType: 'contains', reply: 'Membership plans: Monthly ₹799, Quarterly ₹2099, Half-yearly ₹3599, Annual ₹5999. Personal trainer available!', replyType: 'text' },
      { keyword: 'timing', matchType: 'contains', reply: 'We are open 5am to 11pm all 7 days. No holiday closures!', replyType: 'text' },
      { keyword: 'join', matchType: 'contains', reply: 'Awesome! Let me get your membership details.', replyType: 'booking_trigger' },
      { keyword: 'membership', matchType: 'contains', reply: 'Awesome! Let me get your membership details.', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'plan', label: 'Which membership plan? (monthly/quarterly/half-yearly/annual)', required: true, order: 2 },
      { fieldKey: 'startDate', label: 'When would you like to start?', required: true, order: 3 }
    ]
  },
  {
    businessType: 'medical',
    defaultRules: [
      { keyword: 'timing', matchType: 'contains', reply: 'We are open 8am to 10pm all days. 24-hour emergency medicines also available.', replyType: 'text' },
      { keyword: 'available', matchType: 'contains', reply: 'Please share the medicine name and we will check stock and get back to you shortly.', replyType: 'text' },
      { keyword: 'appointment', matchType: 'contains', reply: 'Let me book a doctor consultation for you.', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is the patient\'s name?', required: true, order: 1 },
      { fieldKey: 'issue', label: 'What is the health concern?', required: true, order: 2 },
      { fieldKey: 'preferredTime', label: 'Preferred consultation time?', required: true, order: 3 }
    ]
  },
  {
    businessType: 'general',
    defaultRules: [
      { keyword: 'price', matchType: 'contains', reply: 'Please share the product name and we will send you the latest price!', replyType: 'text' },
      { keyword: 'timing', matchType: 'contains', reply: 'We are open Monday to Saturday 10am to 8pm.', replyType: 'text' },
      { keyword: 'location', matchType: 'contains', reply: 'We are located at [your address here]. You can also WhatsApp us to place an order for home delivery!', replyType: 'text' },
      { keyword: 'order', matchType: 'contains', reply: 'Let me take your order details!', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'item', label: 'What would you like to order?', required: true, order: 2 },
      { fieldKey: 'quantity', label: 'How many pieces?', required: true, order: 3 }
    ]
  }
];

const seedBusinessTypes = async () => {
  try {
    for (const template of templates) {
      const existing = await BusinessTypeTemplate.findOne({ businessType: template.businessType });
      if (!existing) {
        await BusinessTypeTemplate.create(template);
        logger.info(`Business type template created: ${template.businessType}`);
      } else {
        logger.info(`Business type template already exists: ${template.businessType}`);
      }
    }
    logger.info('Business type seeding complete');
  } catch (error) {
    logger.error('Business type seeding error:', error);
    throw error;
  }
};

module.exports = seedBusinessTypes;
