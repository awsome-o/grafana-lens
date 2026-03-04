# E2E Test Prompts

Ready-to-use prompts for `openclaw agent --session-id <session> -m "<prompt>"`.
All tests use **gateway mode** (no `--local` flag).

---

## Discovery (`e2e-discovery`)

### D1: Explore Datasources
```
What datasources are configured in Grafana? List them all.
```

### D2: List Metrics
```
What metrics are available in Grafana? Show me metrics with the 'up' prefix.
```

### D3: Search Dashboards
```
Search for any existing dashboards in Grafana.
```

---

## Metrics Push (`e2e-metrics-push`)

### MP1: Register Metric
```
Register a custom gauge metric called 'e2e_test_gauge' with help 'E2E test metric' and label names ['env', 'version'].
```

### MP2: Push Values
```
Push these metrics: e2e_test_gauge=42 with labels env=test,version=v1 and also e2e_test_counter=1 as a counter type.
```

### MP3: List Custom Metrics
```
List all custom metrics I've pushed.
```

### MP4: Delete Metric
```
Delete the custom metric called 'e2e_test_counter'.
```

---

## Query (`e2e-query`)

### Q1: Instant Query
```
What is the current value of the 'up' metric? Use a Prometheus query.
```

### Q2: Range Query
```
Show me the 'up' metric over the last 1 hour as a range query with 5-minute steps.
```

### Q3: Query Logs
```
Search for any log entries in Grafana from the last hour. Use a Loki query.
```

### Q4: Explain Metric
```
Explain the 'up' metric -- what is its current value, trend, and stats?
```

---

## Dashboard (`e2e-dashboard`)

### DB1: Create Dashboard
```
Create a Grafana dashboard using the metric-explorer template with the title 'E2E Test Dashboard'.
```

### DB2: Get Dashboard
```
Show me the details of the dashboard titled 'E2E Test Dashboard' -- what panels does it have?
```

### DB3: Update — Add Panel
```
Add a new timeseries panel titled 'E2E Added Panel' to the 'E2E Test Dashboard' with PromQL query 'up'.
```

### DB4: Update — Remove Panel
```
Remove the panel titled 'E2E Added Panel' from the 'E2E Test Dashboard'.
```

### DB5: Share Dashboard
```
Share the first panel of the 'E2E Test Dashboard' as an image.
```

### DB6: Cleanup — Delete Dashboard
```
Delete the dashboard titled 'E2E Test Dashboard'. Yes, I confirm the deletion.
```

---

## Alerting (`e2e-alerting`)

### A1: Setup Webhook
```
Set up the Grafana alert webhook so the agent can receive alert notifications.
```

### A2: List Alerts
```
Are there any active Grafana alerts right now?
```

### A3: Create Alert
```
Create a Grafana alert called 'E2E Test Alert' that fires when the 'up' metric is less than 1 for 1 minute.
```

### A4: Create Annotation
```
Create a Grafana annotation saying 'E2E test annotation' with tags 'e2e' and 'test'.
```

### A5: List Annotations
```
List recent annotations with the tag 'e2e'.
```
