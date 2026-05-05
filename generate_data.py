import json
import os
import sys

LOCATIONS = {
    'national': {'tax_rate': 0.22, 'housing_multiplier': 1.0, 'col_multiplier': 1.0},
    'ny': {'tax_rate': 0.28, 'housing_multiplier': 1.45, 'col_multiplier': 1.40},
    'ca': {'tax_rate': 0.28, 'housing_multiplier': 1.50, 'col_multiplier': 1.45},
    'tx': {'tax_rate': 0.18, 'housing_multiplier': 0.85, 'col_multiplier': 0.90},
    'il': {'tax_rate': 0.24, 'housing_multiplier': 0.95, 'col_multiplier': 1.00},
    'fl': {'tax_rate': 0.18, 'housing_multiplier': 0.90, 'col_multiplier': 0.92},
}

HOUSEHOLD_TYPES = ['all', 'single', 'dual']
SEXES = ['all', 'male', 'female']
EDUCATIONS = ['all', 'hs', 'bachelors', 'masters']
RACES = ['all', 'white', 'black', 'asian', 'hispanic']


def generate_brackets(base_income):
    """Generate percentile brackets using a tapered growth curve."""
    brackets = []
    for percentile in range(1, 100):
        # Taper growth rate from 4.5% at low percentiles to 1.5% at high percentiles
        growth_rate = 0.045 - (0.030 * (percentile / 100))
        income = base_income * ((1 + growth_rate) ** percentile)
        brackets.append({"income": round(income, 2), "percentile": percentile})
    return brackets


def main():
    os.makedirs('data', exist_ok=True)

    existing_files = [f for f in os.listdir('data') if f.endswith('.json')]
    if existing_files:
        print(f"Warning: Existing data files detected: {existing_files}")
        if os.environ.get('CI') or not sys.stdin.isatty():
            print('Non-interactive environment detected. Proceeding with overwrite.')
        else:
            response = input("Overwrite existing data files? (y/N): ").strip().lower()
            if response not in ('y', 'yes'):
                print("Aborted. No files were changed.")
                sys.exit(0)

    for loc, meta in LOCATIONS.items():
        data = {
            "location": loc,
            "tax_rate": meta["tax_rate"],
            "housing_multiplier": meta["housing_multiplier"],
            "col_multiplier": meta["col_multiplier"],
            "demographics": {}
        }

        for ht in HOUSEHOLD_TYPES:
            data["demographics"][ht] = {}
            for sx in SEXES:
                data["demographics"][ht][sx] = {}
                for ed in EDUCATIONS:
                    data["demographics"][ht][sx][ed] = {}
                    for rc in RACES:
                        base_income = 12000

                        if ht == 'dual':
                            base_income += 15000
                        elif ht == 'single':
                            base_income -= 2000

                        if ed == 'bachelors':
                            base_income += 8000
                        elif ed == 'masters':
                            base_income += 14000
                        elif ed == 'hs':
                            base_income -= 3000

                        # Deliberately unbiased: sex and race do not affect income in this model.
                        # Previous versions applied discriminatory adjustments here;
                        # those have been removed to provide equitable benchmarking.

                        data["demographics"][ht][sx][ed][rc] = generate_brackets(base_income)

        filepath = f'data/{loc}.json'
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2)
        print(f"Generated {filepath}")


if __name__ == "__main__":
    main()
