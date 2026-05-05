import json
import os
import pandas as pd

LOCATIONS = {
    'national': {'tax_rate': 0.22, 'housing_multiplier': 1.0, 'col_multiplier': 1.0, 'prefix': 'us'},
    'ny': {'tax_rate': 0.28, 'housing_multiplier': 1.45, 'col_multiplier': 1.40, 'prefix': 'ny'},
    'ca': {'tax_rate': 0.28, 'housing_multiplier': 1.50, 'col_multiplier': 1.45, 'prefix': 'ca'},
    'tx': {'tax_rate': 0.18, 'housing_multiplier': 0.85, 'col_multiplier': 0.90, 'prefix': 'tx'},
    'il': {'tax_rate': 0.24, 'housing_multiplier': 0.95, 'col_multiplier': 1.00, 'prefix': 'il'},
    'fl': {'tax_rate': 0.18, 'housing_multiplier': 0.90, 'col_multiplier': 0.92, 'prefix': 'fl'},
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
        income = df_sorted.iloc[idx][val_col]
        brackets.append({"income": round(float(income), 2), "percentile": percentile})
    return brackets

def main():
    os.makedirs('data', exist_ok=True)
    raw_dir = 'raw_data'

    for loc, meta in LOCATIONS.items():
        p_file = os.path.join(raw_dir, f"psam_p{meta['prefix']}.csv")
        h_file = os.path.join(raw_dir, f"psam_h{meta['prefix']}.csv")

        if not os.path.exists(p_file) or not os.path.exists(h_file):
            continue

        df_p = pd.read_csv(p_file, usecols=['SERIALNO', 'PINCP', 'PWGTP', 'SEX', 'SCHL', 'RAC1P', 'HISP'])
        df_h = pd.read_csv(h_file, usecols=['SERIALNO', 'HINCP', 'HHT'])
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

if __name__ == "__main__":
    main()