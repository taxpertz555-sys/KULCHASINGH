# Deploy Hotel Queue App

## Easiest Option: Render

1. Create a GitHub repository and upload the files from this folder.
2. Go to Render, choose New > Web Service, and connect the repository.
3. Use these settings:
   - Runtime: Python
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `python server.py`
4. Add environment variable `PUBLIC_URL` after Render gives you the live URL.
   Example: `https://your-app-name.onrender.com`
5. For persistent queue data, add a persistent disk mounted at `/var/data`.
   The app is already configured to write queue data there through `DATA_DIR=/var/data`.

Customer URL:

```text
https://your-app-name.onrender.com/#customer
```

Owner URL:

```text
https://your-app-name.onrender.com/#owner
```

## Important Notes

- Without a persistent disk or database, the queue data can disappear when the service restarts or redeploys.
- After changing `PUBLIC_URL`, open the owner dashboard and copy/print the new customer QR.
- The owner PIN is saved in `queue-data.json`; set it from the owner dashboard after deploy.
