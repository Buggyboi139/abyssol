import json
import os
import random

locations = ['national', 'ny', 'ca', 'tx', 'il', 'fl']
os.makedirs('data', exist_ok=True)

for loc in locations:
    tax_rate = 0.22 if loc == 'national' else round(random.uniform(0.18, 0.28), 2)
    data = {
        "location": loc,
        "tax_rate": tax_rate,
        "brackets": []
    }
    
    income = 1000
    for percentile in range(1, 100):
        data["brackets"].append({"income": income, "percentile": percentile})
        income += random.randint(100, 300)
        
    with open(f'data/{loc}.json', 'w') as f:
        json.dump(data, f, indent=4)
