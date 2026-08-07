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
  },
  {
    businessType: 'boutique',
    defaultRules: [
      { keyword: '1', matchType: 'exact', reply: 'Here\'s our latest collection! Check out our photos/catalog below. Reply with an item name or code and we\'ll confirm size & price for you.', replyType: 'text' },
      { keyword: '2', matchType: 'exact', reply: 'We are open Monday to Saturday, 10am to 8pm.', replyType: 'text' },
      { keyword: '3', matchType: 'exact', reply: 'You can find us at [store address]. Reply for the map location!', replyType: 'text' },
      { keyword: '4', matchType: 'exact', reply: 'Tell us what you\'re looking for and we\'ll help you find it!', replyType: 'text' }
    ]
  },
  {
    businessType: 'photographer',
    defaultRules: [
      { keyword: '1', matchType: 'exact', reply: 'Our packages start from ₹15,000 for events and ₹5,000 for portrait sessions. Reply for a detailed quote!', replyType: 'text' },
      { keyword: '2', matchType: 'exact', reply: 'Let\'s check availability for your date!', replyType: 'booking_trigger' },
      { keyword: '3', matchType: 'exact', reply: 'Check out our portfolio: [Instagram/website link]', replyType: 'text' },
      { keyword: '4', matchType: 'exact', reply: 'We\'re based in [city] and travel for events. Let us know your location!', replyType: 'text' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'eventType', label: 'What type of shoot? wedding/portrait/event', required: true, order: 2 },
      { fieldKey: 'eventDate', label: 'What is the event date?', required: true, order: 3 },
      { fieldKey: 'location', label: 'What is the location?', required: true, order: 4 }
    ]
  },
  {
    businessType: 'caterer',
    defaultRules: [
      { keyword: '1', matchType: 'exact', reply: 'Our packages range from ₹250-₹800 per plate depending on menu. Reply for our full menu list!', replyType: 'text' },
      { keyword: '2', matchType: 'exact', reply: 'Let\'s get your event booked!', replyType: 'booking_trigger' },
      { keyword: '3', matchType: 'exact', reply: 'Our office hours are 10am to 7pm, all days.', replyType: 'text' },
      { keyword: '4', matchType: 'exact', reply: 'We serve [area/city]. Contact us to confirm availability for your location.', replyType: 'text' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'eventType', label: 'What type of event is this?', required: true, order: 2 },
      { fieldKey: 'guestCount', label: 'How many guests?', required: true, order: 3 },
      { fieldKey: 'eventDate', label: 'What is the event date?', required: true, order: 4 }
    ]
  },
  {
    businessType: 'tutor',
    defaultRules: [
      { keyword: '1', matchType: 'exact', reply: 'We teach [subjects] for classes [X-Y]. Fees start from ₹1500/month. Reply for detailed fee structure!', replyType: 'text' },
      { keyword: '2', matchType: 'exact', reply: 'Let\'s schedule your free trial class!', replyType: 'booking_trigger' },
      { keyword: '3', matchType: 'exact', reply: 'Batches available: Morning, Evening, and Weekend. Reply to know timings for your grade.', replyType: 'text' },
      { keyword: '4', matchType: 'exact', reply: 'We\'re located at [address] / We also offer home tuitions in [area].', replyType: 'text' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'studentGrade', label: 'Which class/grade is this for?', required: true, order: 2 },
      { fieldKey: 'subject', label: 'Which subject?', required: true, order: 3 },
      { fieldKey: 'preferredTime', label: 'What time works best for you?', required: false, order: 4 }
    ]
  },
  {
    businessType: 'jeweller',
    defaultRules: [
      { keyword: '1', matchType: 'exact', reply: 'We have gold, silver, and diamond collections. Reply to see our latest designs!', replyType: 'text' },
      { keyword: '2', matchType: 'exact', reply: 'We are open Monday to Saturday, 10:30am to 8:30pm.', replyType: 'text' },
      { keyword: '3', matchType: 'exact', reply: 'Visit us at [store address].', replyType: 'text' },
      { keyword: '4', matchType: 'exact', reply: 'Let\'s discuss your custom design requirements!', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'designType', label: 'What would you like custom made? (ring, necklace, etc.)', required: true, order: 2 },
      { fieldKey: 'budget', label: 'What is your budget?', required: false, order: 3 }
    ]
  },
  {
    businessType: 'grocery',
    defaultRules: [
      { keyword: '1', matchType: 'exact', reply: 'Check out today\'s fresh offers and discounts! Reply \'list\' for the full offer list.', replyType: 'text' },
      { keyword: '2', matchType: 'exact', reply: 'We deliver in [area] within 1 hour. Open 7am to 10pm daily.', replyType: 'text' },
      { keyword: '3', matchType: 'exact', reply: 'Visit us at [store address].', replyType: 'text' },
      { keyword: '4', matchType: 'exact', reply: 'Let\'s place your order!', replyType: 'booking_trigger' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'items', label: 'What would you like to order?', required: true, order: 2 },
      { fieldKey: 'deliveryAddress', label: 'What is your delivery address?', required: true, order: 3 }
    ]
  },
  {
    businessType: 'bakery',
    defaultRules: [
      { keyword: '1', matchType: 'exact', reply: 'Our menu includes cakes, pastries, and fresh bakes. Reply for prices!', replyType: 'text' },
      { keyword: '2', matchType: 'exact', reply: 'Let\'s get your custom cake order started!', replyType: 'booking_trigger' },
      { keyword: '3', matchType: 'exact', reply: 'We are open 8am to 9pm, all days.', replyType: 'text' },
      { keyword: '4', matchType: 'exact', reply: 'Visit us at [store address] for fresh pickups!', replyType: 'text' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'cakeFlavor', label: 'What flavor and weight?', required: true, order: 2 },
      { fieldKey: 'pickupDate', label: 'When would you like to pick it up?', required: true, order: 3 }
    ]
  },
  {
    businessType: 'electronics_repair',
    defaultRules: [
      { keyword: '1', matchType: 'exact', reply: 'We repair phones, laptops, and ACs. Reply with your device and issue for a price estimate!', replyType: 'text' },
      { keyword: '2', matchType: 'exact', reply: 'Let\'s book your repair!', replyType: 'booking_trigger' },
      { keyword: '3', matchType: 'exact', reply: 'We are open Monday to Saturday, 10am to 7pm.', replyType: 'text' },
      { keyword: '4', matchType: 'exact', reply: 'Visit us at [shop address], or ask about pickup service!', replyType: 'text' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'deviceType', label: 'What device do you have?', required: true, order: 2 },
      { fieldKey: 'issue', label: 'What\'s the problem?', required: true, order: 3 }
    ]
  },
  {
    businessType: 'real_estate',
    defaultRules: [
      { keyword: '1', matchType: 'exact', reply: 'We have properties available for rent and sale. Reply with your budget and preferred area!', replyType: 'text' },
      { keyword: '2', matchType: 'exact', reply: 'Let\'s schedule a site visit!', replyType: 'booking_trigger' },
      { keyword: '3', matchType: 'exact', reply: 'Reach us directly at [contact number] for urgent queries.', replyType: 'text' },
      { keyword: '4', matchType: 'exact', reply: 'We cover [areas/localities served].', replyType: 'text' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'propertyType', label: 'Buy or rent?', required: true, order: 2 },
      { fieldKey: 'preferredDate', label: 'What date works for the site visit?', required: true, order: 3 }
    ]
  },
  {
    businessType: 'driving_school',
    defaultRules: [
      { keyword: '1', matchType: 'exact', reply: 'Two-wheeler course: ₹2000, Four-wheeler course: ₹5000. Reply for full details!', replyType: 'text' },
      { keyword: '2', matchType: 'exact', reply: 'Let\'s book your first driving slot!', replyType: 'booking_trigger' },
      { keyword: '3', matchType: 'exact', reply: 'Classes run 6am to 8pm, 7 days a week — pick your convenient slot.', replyType: 'text' },
      { keyword: '4', matchType: 'exact', reply: 'Pickup available in [area], or visit us at [address].', replyType: 'text' }
    ],
    bookingFields: [
      { fieldKey: 'customerName', label: 'What is your name?', required: true, order: 1 },
      { fieldKey: 'licenseType', label: 'Two-wheeler or four-wheeler?', required: true, order: 2 },
      { fieldKey: 'preferredSlot', label: 'What time slot works best for you?', required: false, order: 3 }
    ]
  },
  {
    businessType: 'travels',
    defaultRules: [
      { keyword: '1', matchType: 'exact', reply: "We offer One Way, Round Trip, and Local Rental packages to all major cities. Reply '2' to get a quote for your trip!", replyType: 'text' },
      { keyword: '2', matchType: 'exact', reply: "Let's get your trip details!", replyType: 'booking_trigger' },
      { keyword: '3', matchType: 'exact', reply: "We're available 24/7 for bookings. Advance booking recommended for outstation trips.", replyType: 'text' },
      { keyword: '4', matchType: 'exact', reply: "We serve [cities/routes]. Contact us to confirm your route.", replyType: 'text' }
    ],
    // NOTE: summaryLabel fields below only apply to a freshly-seeded template.
    // seedBusinessTypes() skips creation when a 'travels' template already
    // exists in the DB, so `npm run seed` will NOT backfill summaryLabel onto
    // an already-seeded template. To apply it to an existing doc, delete the
    // existing 'travels' template and reseed, or run a small update script.
    bookingFields: [
      { fieldKey: 'tripType', label: 'What type of trip? Reply: One Way / Round Trip / Local Rental', summaryLabel: 'Trip type', required: true, order: 1, fieldType: 'buttons', options: ['One Way', 'Round Trip', 'Local Rental'] },
      { fieldKey: 'pickupLocation', label: 'Pickup location?', summaryLabel: 'Pickup', required: true, order: 2 },
      { fieldKey: 'dropLocation', label: 'Drop location?', summaryLabel: 'Drop', required: true, order: 3 },
      { fieldKey: 'travelDate', label: 'What date do you need the vehicle? (DD/MM/YYYY)', summaryLabel: 'Date', required: true, order: 4 },
      { fieldKey: 'pickupTime', label: 'What time should we pick you up?', summaryLabel: 'Time', required: true, order: 5 },
      { fieldKey: 'vehicleType', label: "Vehicle preference? Hatchback / Sedan / SUV / Luxury / Tempo / Mini Bus / Bus (or say 'any')", summaryLabel: 'Vehicle', required: true, order: 6, fieldType: 'list', options: ['Hatchback', 'Sedan', 'SUV', 'Luxury', 'Tempo', 'Mini Bus', 'Bus'] },
      { fieldKey: 'acRequired', label: 'Do you need AC? Reply Yes or No', summaryLabel: 'AC', required: false, order: 7, fieldType: 'buttons', options: ['Yes', 'No'] },
      { fieldKey: 'carrierRequired', label: 'Do you need a carrier for luggage? Reply Yes or No', summaryLabel: 'Luggage carrier', required: false, order: 8, fieldType: 'buttons', options: ['Yes', 'No'] },
      { fieldKey: 'tollParkingIncluded', label: 'Should toll & parking be included in the fare? Reply Yes or No', summaryLabel: 'Toll & parking included', required: false, order: 9, fieldType: 'buttons', options: ['Yes', 'No'] }
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
