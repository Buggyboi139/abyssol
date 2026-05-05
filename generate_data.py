import json
import os
import sys
import math

LOCATIONS = {
    'national': {'tax_rate': 0.22, 'housing_multiplier': 1.0, 'col_multiplier': 1.0},
    'ny': {'tax_rate': 0.28, 'housing_multiplier': 1.45, 'col_multiplier': 1.40},
    'ca': {'tax_rate': 0.28, 'housing_multiplier': 1.50, 'col_multiplier': 1.45},
    'tx': {'tax_rate': 0.18, 'housing_multiplier': 0.85, 'col_multiplier': 0.90},
    'il': {'tax_rate': 0.24, 'housing_multiplier': 0.95, 'col_multiplier': 1.00},
    'fl': {'tax_rate': 0.18, 'housing_multiplier': 0.90, 'col_multiplier': 0.92},
}

HOUSEHOLD_TYPES = ['all', 'single', 'dual']
SEXES =['all', 'male', 'female']
EDUCATIONS = ['all', 'hs', 'bachelors', 'masters']
RACES = ['all', 'white', 'black', 'asian', 'hispanic']


def generate_brackets(base_income):
    brackets =[]
    for percentile in range(1, 100):
        p_norm = percentile / 100.0
        multiplier = math.exp(2.8 * (p_norm ** 1.8))
        income = base_income * multiplier
        brackets.append({"income": round(income, 2), "percentile": percentile})
    return brackets


def main():
    os.makedirs('data', exist_ok=True)

    existing_files =[f for f in os.listdir('data') if f.endswith('.json')]
    if existing_files:
        if os.environ.get('CI') or not sys.stdin.isatty():
            pass
        else:
            response = input("Overwrite existing data files? (y/N): ").strip().lower()
            if response not in ('y', 'yes'):
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
                        base_income = 16000

                        if ht == 'dual':
                            base_income += 18000
                        elif ht == 'single':
                            base_income -= 2000

                        if ed == 'bachelors':
                            base_income += 8000
                        elif ed == 'masters':
                            base_income += 14000
                        elif ed == 'hs':
                            base_income -= 3000

                        data["demographics"][ht][sx][ed][rc] = generate_brackets(base_income)

        filepath = f'data/{loc}.json'
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2)


if __name__ == "__main__":
    main()