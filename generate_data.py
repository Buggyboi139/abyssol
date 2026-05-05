import json
import os

locations =['national', 'ny', 'ca', 'tx', 'il', 'fl']
household_types = ['all', 'single', 'dual']
sexes = ['all', 'male', 'female']
educations =['all', 'hs', 'bachelors', 'masters']
races =['all', 'white', 'black', 'asian', 'hispanic']

os.makedirs('data', exist_ok=True)

def generate_brackets(base_income):
    brackets =[]
    for percentile in range(1, 100):
        income = base_income * (1.045 ** percentile)
        brackets.append({"income": round(income, 2), "percentile": percentile})
    return brackets

for loc in locations:
    if loc == 'national':
        tax_rate = 0.22
    elif loc in ['ny', 'ca']:
        tax_rate = 0.28
    elif loc in ['tx', 'fl']:
        tax_rate = 0.18
    else:
        tax_rate = 0.24
    
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
                data["demographics"][ht][sx][ed] = {}
                for rc in races:
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
                        
                    if sx == 'male':
                        base_income += 2500
                    elif sx == 'female':
                        base_income -= 2000
                        
                    if rc == 'white' or rc == 'asian':
                        base_income += 2000
                    elif rc == 'black' or rc == 'hispanic':
                        base_income -= 1500
                    
                    data["demographics"][ht][sx][ed][rc] = generate_brackets(base_income)
        
    with open(f'data/{loc}.json', 'w') as f:
        json.dump(data, f, indent=4)
