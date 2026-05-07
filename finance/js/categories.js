export const CATEGORY_TAXONOMY = {
  'Food & Dining':[
    'Groceries',
    'Restaurants & Dining Out',
    'Coffee & Cafes',
    'Fast Food',
    'Bars & Alcohol',
    'Food Delivery',
  ],
  'Transportation':[
    'Gas & Fuel',
    'Car Payment',
    'Car Insurance',
    'Parking',
    'Rideshare',
    'Public Transit',
    'Tolls & Fees',
    'Car Maintenance',
  ],
  'Housing':[
    'Rent / Mortgage',
    'HOA Fees',
    'Home Insurance',
    'Home Maintenance',
    'Furniture & Decor',
  ],
  'Utilities':[
    'Electric',
    'Water & Sewer',
    'Gas / Heat',
    'Internet',
    'Cell Phone',
    'Trash',
  ],
  'Entertainment':[
    'Streaming Services',
    'Music Subscriptions',
    'Movies & Events',
    'Gaming',
    'Hobbies',
    'Books & Media',
  ],
  'Health & Wellness':[
    'Health Insurance',
    'Doctor & Urgent Care',
    'Prescriptions',
    'Dental',
    'Vision',
    'Gym & Fitness',
    'Mental Health',
    'Personal Care',
  ],
  'Shopping':[
    'Clothing & Apparel',
    'Electronics',
    'Home Goods',
    'Online Shopping',
    'Gifts',
  ],
  'Financial':[
    'Savings Transfer',
    'Investments',
    'Credit Card Payment',
    'Loan Payment',
    'Bank Fees',
  ],
  'Education':[
    'Student Loans',
    'Tuition & Courses',
    'Books & Supplies',
  ],
  'Travel':[
    'Flights',
    'Hotels & Lodging',
    'Vacation Activities',
  ],
  'Personal & Family':[
    'Childcare',
    'Pet Care',
    'Haircuts & Grooming',
    'Baby',
  ],
  'Business Expenses':[
    'Work Supplies',
    'Software & Subscriptions',
    'Professional Services',
    'Union Dues',
  ],
  'Uncategorized':[],
};

export const FLAT_CATEGORIES = Object.entries(CATEGORY_TAXONOMY).flatMap(
  ([parent, subs]) =>
    subs.length > 0
      ? subs.map(sub => `${parent} > ${sub}`)
      : [parent]
);

export const PARENT_CATEGORIES = Object.keys(CATEGORY_TAXONOMY);

export function getCategoryParent(cat) {
  if (!cat) return 'Uncategorized';
  const idx = cat.indexOf(' > ');
  return idx !== -1 ? cat.substring(0, idx) : cat;
}

export const CATEGORY_COLORS = {
  'Food & Dining':     '#f59e0b',
  'Transportation':    '#0ea5e9',
  'Housing':           '#8b5cf6',
  'Utilities':         '#6366f1',
  'Entertainment':     '#ec4899',
  'Health & Wellness': '#34d399',
  'Shopping':          '#fb7185',
  'Financial':         '#38bdf8',
  'Education':         '#a78bfa',
  'Travel':            '#fbbf24',
  'Personal & Family': '#4ade80',
  'Business Expenses': '#94a3b8',
  'Uncategorized':     '#475569',
};

export function getCategoryColor(cat) {
  if (cat === 'Personal & Family > Baby' || cat === 'Baby') return '#f472b6';
  if (cat === 'Business Expenses > Union Dues' || cat === 'Union Dues') return '#cbd5e1';
  
  const parent = getCategoryParent(cat);
  return CATEGORY_COLORS[parent] ?? '#475569';
}

export const LEGACY_CATEGORY_MAP = {
  'Housing':        'Housing > Rent / Mortgage',
  'Transport':      'Transportation > Gas & Fuel',
  'Food':           'Food & Dining > Groceries',
  'Utilities':      'Utilities > Electric',
  'Entertainment':  'Entertainment > Streaming Services',
  'Health':         'Health & Wellness > Doctor & Urgent Care',
  'Shopping':       'Shopping > Online Shopping',
};