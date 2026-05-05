import os
import json
import datetime
import requests

def fetch_fred_series(series_id, api_key):
    url = f"https://api.stlouisfed.org/fred/series/observations?series_id={series_id}&api_key={api_key}&file_type=json&sort_order=desc&limit=1"
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        data = response.json()
        return float(data['observations'][0]['value'])
    except Exception:
        return None

def main():
    api_key = os.environ.get('FRED_API_KEY')
    
    fallback_data = {
        "mortgage_30yr": 6.85,
        "mortgage_15yr": 6.15,
        "auto_new": 7.20,
        "auto_used": 7.95,
        "fed_funds": 5.25,
        "inflation_cpi": 3.1,
        "last_updated": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }

    if not api_key:
        market_data = fallback_data
    else:
        mortgage_30yr = fetch_fred_series('MORTGAGE30US', api_key)
        mortgage_15yr = fetch_fred_series('MORTGAGE15US', api_key)
        auto_new = fetch_fred_series('RIOSNVA', api_key)
        fed_funds = fetch_fred_series('FEDFUNDS', api_key)
        inflation_cpi = fetch_fred_series('CPIAUCSL', api_key)

        market_data = {
            "mortgage_30yr": mortgage_30yr if mortgage_30yr is not None else fallback_data["mortgage_30yr"],
            "mortgage_15yr": mortgage_15yr if mortgage_15yr is not None else fallback_data["mortgage_15yr"],
            "auto_new": auto_new if auto_new is not None else fallback_data["auto_new"],
            "auto_used": (auto_new + 0.75) if auto_new is not None else fallback_data["auto_used"],
            "fed_funds": fed_funds if fed_funds is not None else fallback_data["fed_funds"],
            "inflation_cpi": inflation_cpi if inflation_cpi is not None else fallback_data["inflation_cpi"],
            "last_updated": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }

    os.makedirs('data', exist_ok=True)
    with open('data/market_rates.json', 'w') as f:
        json.dump(market_data, f, indent=2)

if __name__ == "__main__":
    main()
