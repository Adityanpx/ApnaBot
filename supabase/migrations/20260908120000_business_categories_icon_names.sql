-- business_categories.icon has stored raw emoji characters (mostly '',
-- since only 2 of 22 rows were ever actually seeded with an emoji), which
-- don't render consistently across browsers/OSes (confirmed: category
-- icons missing on the onboarding screen). Investigated first (see
-- session notes): icon is UI-only in this codebase — read by
-- businessCategory.service.js and exposed only via GET /api/business-categories
-- (apnabot-web onboarding picker) and GET /api/admin/business-categories
-- (SuperAdmin's category table). Grepped webhook.controller.js and
-- chatbot.service.js: never sent in any outbound WhatsApp message. So no
-- schema change, no purpose split — values-only migration.
--
-- All 22 rows (not just the 2 that held a real emoji) are backfilled with
-- a stable icon-name key, matching lucide-react's icon-name convention
-- (kebab-case, corresponding to the PascalCase component it exports, e.g.
-- 'graduation-cap' -> GraduationCap). Every name below was checked against
-- the lucide-react version actually installed in ApnaBot-SuperAdmin
-- (0.378.0) before being used here.
--
-- category            | old icon | new icon name      | component
-- --------------------|----------|---------------------|------------------
-- tailor               | ''       | shirt               | Shirt
-- salon                | ''       | scissors            | Scissors
-- garage                | ''       | wrench              | Wrench
-- cab                   | ''       | car-taxi-front      | CarTaxiFront
-- coaching              | ''       | graduation-cap      | GraduationCap
-- gym                   | ''       | dumbbell            | Dumbbell
-- medical               | ''       | stethoscope         | Stethoscope
-- general               | ''       | store               | Store
-- photographer          | ''       | camera              | Camera
-- caterer               | ''       | utensils            | Utensils
-- tutor                 | ''       | book-open           | BookOpen
-- jeweller               | ''       | gem                | Gem
-- boutique               | ''       | shopping-bag       | ShoppingBag
-- grocery                | ''       | shopping-cart      | ShoppingCart
-- bakery                 | ''       | cake               | Cake
-- electronics_repair     | ''       | cpu                | Cpu
-- real_estate            | ''       | building-2         | Building2
-- driving_school         | ''       | car-front          | CarFront
-- travels                | ''       | plane              | Plane
-- software_it            | ''       | code               | Code
-- maha_eseva_kendra      | '🏛️'     | landmark           | Landmark
-- tax_consultant         | '📋'     | calculator         | Calculator
update business_categories set icon = 'shirt' where value = 'tailor';
update business_categories set icon = 'scissors' where value = 'salon';
update business_categories set icon = 'wrench' where value = 'garage';
update business_categories set icon = 'car-taxi-front' where value = 'cab';
update business_categories set icon = 'graduation-cap' where value = 'coaching';
update business_categories set icon = 'dumbbell' where value = 'gym';
update business_categories set icon = 'stethoscope' where value = 'medical';
update business_categories set icon = 'store' where value = 'general';
update business_categories set icon = 'camera' where value = 'photographer';
update business_categories set icon = 'utensils' where value = 'caterer';
update business_categories set icon = 'book-open' where value = 'tutor';
update business_categories set icon = 'gem' where value = 'jeweller';
update business_categories set icon = 'shopping-bag' where value = 'boutique';
update business_categories set icon = 'shopping-cart' where value = 'grocery';
update business_categories set icon = 'cake' where value = 'bakery';
update business_categories set icon = 'cpu' where value = 'electronics_repair';
update business_categories set icon = 'building-2' where value = 'real_estate';
update business_categories set icon = 'car-front' where value = 'driving_school';
update business_categories set icon = 'plane' where value = 'travels';
update business_categories set icon = 'code' where value = 'software_it';
update business_categories set icon = 'landmark' where value = 'maha_eseva_kendra';
update business_categories set icon = 'calculator' where value = 'tax_consultant';
