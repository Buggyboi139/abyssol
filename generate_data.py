import json
import os
import random

locations = ['national', 'ny', 'ca', 'tx', 'il', 'fl']
household_types = ['all', 'single', 'dual']
sexes = ['all', 'male', 'female']
educations = ['all', 'hs', 'bachelors', 'masters']

os.makedirs('data', exist_ok=True)

def generate_brackets(base_income, increment_range):
    brackets = []
    income = base_income
    for percentile in range(1, 100):
        brackets.append({"income": income, "percentile": percentile})
        income += random.randint(*increment_range)
    return brackets

for loc in locations:
    tax_rate = 0.22 if loc == 'national' else round(random.uniform(0.18, 0.28), 2)
    
    data = {
        "location": loc,
        "tax_rate": tax_rate,
        "demographics": {}
    }
    
    for ht in household_types:
        data["demographics"][ht] = {}
        for sx in sexes:
            data["demographics"][ht][sx] = {}
            for ed in educations:
                
                base_income = 1000
                increment_min, increment_max = 100, 300
                
                if ht == 'dual':
                    base_income += 2000
                    increment_min += 50
                    increment_max += 150
                elif ht == 'single':
                    base_income -= 200
                    
                if ed == 'bachelors':
                    base_income += 1000
                    increment_min += 50
                    increment_max += 100
                elif ed == 'masters':
                    base_income += 2000
                    increment_min += 100
                    increment_max += 200
                elif ed == 'hs':
                    base_income -= 300
                    
                if sx == 'male':
                    base_income += 300
                elif sx == 'female':
                    base_income -= 200
                
                data["demographics"][ht][sx][ed] = generate_brackets(base_income, (increment_min, increment_max))
        
    with open(f'data/{loc}.json', 'w') as f:
        json.dump(data, f, indent=4)
