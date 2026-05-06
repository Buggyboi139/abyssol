import json
import os
import pandas as pd

INFLATION_MULTIPLIER = 1.06

LOCATIONS = {
    'national': {'tax_rate': 0.22, 'housing_multiplier': 1.0, 'col_multiplier': 1.0, 'alpha': 'us', 'fips': 'us'},
    'ny': {'tax_rate': 0.28, 'housing_multiplier': 1.45, 'col_multiplier': 1.40, 'alpha': 'ny', 'fips': '36'},
    'ca': {'tax_rate': 0.28, 'housing_multiplier': 1.50, 'col_multiplier': 1.45, 'alpha': 'ca', 'fips': '06'},
    'tx': {'tax_rate': 0.18, 'housing_multiplier': 0.85, 'col_multiplier': 0.90, 'alpha': 'tx', 'fips': '48'},
    'il': {'tax_rate': 0.24, 'housing_multiplier': 0.95, 'col_multiplier': 1.00, 'alpha': 'il', 'fips': '17'},
    'fl': {'tax_rate': 0.18, 'housing_multiplier': 0.90, 'col_multiplier': 0.92, 'alpha': 'fl', 'fips': '12'},
}

HOUSEHOLD_TYPES = ['all', 'single', 'dual']
SEXES = ['all', 'male', 'female']
EDUCATIONS = ['all', 'hs', 'bachelors', 'masters']
RACES = ['all', 'white', 'black', 'asian', 'hispanic']

def generate_brackets(df, val_col, weight_col):
    if df.empty or df[weight_col].sum() == 0:
        return [{"income": 0, "percentile": p} for p in range(1, 100)]
    
    df_sorted = df.dropna(subset=[val_col]).sort_values(val_col)
    cumsum = df_sorted[weight_col].cumsum().values
    cutoff = df_sorted[weight_col].sum()
    
    brackets = []
    for percentile in range(1, 100):
        target = cutoff * (percentile / 100.0)
        idx = cumsum.searchsorted(target)
        if idx >= len(df_sorted):
            idx = len(df_sorted) - 1
        income = df_sorted.iloc[idx][val_col] * INFLATION_MULTIPLIER
        brackets.append({"income": round(float(income), 2), "percentile": percentile})
    return brackets

def find_files(raw_dir, meta, file_type):
    if meta['alpha'] == 'us':
        split_a = os.path.join(raw_dir, f"psam_{file_type}usa.csv")
        split_b = os.path.join(raw_dir, f"psam_{file_type}usb.csv")
        if os.path.exists(split_a) and os.path.exists(split_b):
            return [split_a, split_b]
        
        single_us = os.path.join(raw_dir, f"psam_{file_type}us.csv")
        if os.path.exists(single_us):
            return [single_us]
        return []
    
    fips_file = os.path.join(raw_dir, f"psam_{file_type}{meta['fips']}.csv")
    if os.path.exists(fips_file):
        return [fips_file]
        
    alpha_file = os.path.join(raw_dir, f"psam_{file_type}{meta['alpha']}.csv")
    if os.path.exists(alpha_file):
        return [alpha_file]
        
    return []

def main():
    os.makedirs('data', exist_ok=True)
    raw_dir = os.environ.get('RAW_DATA_DIR', './raw_data')
    
    print("--- STARTING CENSUS DATA GENERATION ---")
    
    if not os.path.exists(raw_dir):
        print(f"❌ FATAL ERROR: Directory '{raw_dir}' does not exist.")
        return

    for loc, meta in LOCATIONS.items():
        print(f"\nEvaluating Location: {loc.upper()}")
        
        p_files = find_files(raw_dir, meta, 'p')
        h_files = find_files(raw_dir, meta, 'h')

        if not p_files:
            print(f"  ❌ MISSING PERSON FILE: Could not find Person CSV for {loc.upper()}")
            continue
            
        if not h_files:
            print(f"  ❌ MISSING HOUSING FILE: Could not find Housing CSV for {loc.upper()}")
            continue

        print(f"  ✅ FOUND FILES! Loading {len(p_files)} Person file(s) and {len(h_files)} Housing file(s)...")
        
        df_p_list = [pd.read_csv(f, usecols=['SERIALNO', 'PINCP', 'PWGTP', 'SEX', 'SCHL', 'RAC1P', 'HISP']) for f in p_files]
        df_p = pd.concat(df_p_list, ignore_index=True)
        
        df_h_list = [pd.read_csv(f, usecols=['SERIALNO', 'HINCP', 'HHT']) for f in h_files]
        df_h = pd.concat(df_h_list, ignore_index=True)
        
        print("  ⏳ Calculating Percentiles...")
        df = pd.merge(df_p, df_h, on='SERIALNO', how='inner')

        data = {
            "location": loc,
            "tax_rate": meta["tax_rate"],
            "housing_multiplier": meta["housing_multiplier"],
            "col_multiplier": meta["col_multiplier"],
            "demographics": {}
        }

        for ht in HOUSEHOLD_TYPES:
            data["demographics"][ht] = {}
            if ht == 'dual':
                df_ht = df[df['HHT'] == 1]
                val_col = 'HINCP'
            elif ht == 'single':
                df_ht = df[df['HHT'] != 1]
                val_col = 'PINCP'
            else:
                df_ht = df
                val_col = 'PINCP'

            for sx in SEXES:
                data["demographics"][ht][sx] = {}
                if sx == 'male':
                    df_sx = df_ht[df_ht['SEX'] == 1]
                elif sx == 'female':
                    df_sx = df_ht[df_ht['SEX'] == 2]
                else:
                    df_sx = df_ht

                for ed in EDUCATIONS:
                    data["demographics"][ht][sx][ed] = {}
                    if ed == 'hs':
                        df_ed = df_sx[df_sx['SCHL'].isin([16, 17, 18, 19])]
                    elif ed == 'bachelors':
                        df_ed = df_sx[df_sx['SCHL'] == 21]
                    elif ed == 'masters':
                        df_ed = df_sx[df_sx['SCHL'] == 22]
                    else:
                        df_ed = df_sx

                    for rc in RACES:
                        if rc == 'hispanic':
                            df_rc = df_ed[df_ed['HISP'] != 1]
                        elif rc == 'white':
                            df_rc = df_ed[(df_ed['RAC1P'] == 1) & (df_ed['HISP'] == 1)]
                        elif rc == 'black':
                            df_rc = df_ed[(df_ed['RAC1P'] == 2) & (df_ed['HISP'] == 1)]
                        elif rc == 'asian':
                            df_rc = df_ed[(df_ed['RAC1P'] == 6) & (df_ed['HISP'] == 1)]
                        else:
                            df_rc = df_ed

                        data["demographics"][ht][sx][ed][rc] = generate_brackets(df_rc, val_col, 'PWGTP')

        with open(f'data/{loc}.json', 'w') as f:
            json.dump(data, f, indent=2)
            
        print(f"  🎉 SUCCESS! Generated data/{loc}.json")

if __name__ == "__main__":
    main()