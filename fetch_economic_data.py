import os
import datetime
import requests
from supabase import create_client

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
    supabase_url = os.environ.get('SUPABASE_URL')
    supabase_key = os.environ.get('SUPABASE_SERVICE_KEY')
    
    fallback_data = {
        "mortgage_30yr": 6.85,
        "auto_new": 7.20,
        "inflation": 3.1
    }

    if not api_key:
        market_data = fallback_data
    else:
        market_data = {
            "mortgage_30yr": fetch_fred_series('MORTGAGE30US', api_key) or fallback_data["mortgage_30yr"],
            "auto_new": fetch_fred_series('RIOSNVA', api_key) or fallback_data["auto_new"],
            "inflation": fetch_fred_series('CPIAUCSL', api_key) or fallback_data["inflation"]
        }

    if supabase_url and supabase_key:
        supabase = create_client(supabase_url, supabase_key)
        payload = {
            "date": datetime.date.today().isoformat(),
            "fred_mortgage_30yr": market_data["mortgage_30yr"],
            "fred_auto_new": market_data["auto_new"],
            "fred_inflation": market_data["inflation"],
            "last_updated": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }
        supabase.table("macro_data").upsert(payload).execute()

if __name__ == "__main__":
    main()
