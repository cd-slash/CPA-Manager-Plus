package providerusage

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return fn(req) }

func jsonResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func TestZAIUsesFixedOriginAndReturnsOnlySanitizedRemainingQuota(t *testing.T) {
	service := New(nil, "secret-zai-key", "", nil)
	service.client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != zaiQuotaURL {
			t.Fatalf("URL = %q", req.URL)
		}
		if req.Header.Get("Authorization") != "Bearer secret-zai-key" {
			t.Fatal("missing server-side key")
		}
		return jsonResponse(`{"data":{"level":"Pro","limits":[{"unit":3,"number":5,"percentage":100,"nextResetTime":2000000000000},{"unit":6,"number":1,"percentage":0}]}}`), nil
	})

	result, err := service.ZAI(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Windows) != 2 || *result.Windows[0].RemainingPercent != 0 || *result.Windows[1].RemainingPercent != 100 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if strings.Contains(strings.ToLower(strings.TrimSpace(result.Plan)), "secret") {
		t.Fatal("secret leaked")
	}
}

func TestXAIUsesFixedOriginAndKeepsSuccessfulModels(t *testing.T) {
	manager := managerconfig.New(config.Config{CPAUpstreamURL: "http://cpa.internal", ManagementKey: "management-secret"}, nil, nil)
	service := New(manager, "", "", []string{"grok-4.7", "grok-4.3"})
	calls := 0
	service.client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		if req.URL.String() != "http://cpa.internal/v0/management/api-call" {
			t.Fatalf("URL = %q", req.URL)
		}
		if req.Header.Get("Authorization") != "Bearer management-secret" {
			t.Fatal("missing management auth")
		}
		body, _ := io.ReadAll(req.Body)
		if !strings.Contains(string(body), xaiCompletionsURL) || strings.Contains(string(body), "management-secret") {
			t.Fatalf("unsafe payload: %s", body)
		}
		var payload struct {
			Header map[string]string `json:"header"`
		}
		if err := json.Unmarshal(body, &payload); err != nil || payload.Header["Content-Type"] != "application/json" {
			t.Fatal("xAI JSON probe must declare its upstream content type")
		}
		if calls == 1 {
			return jsonResponse(`{"status_code":404,"header":{},"body":"unknown model"}`), nil
		}
		return jsonResponse(`{"statusCode":200,"headers":{"X-RateLimit-Limit-Tokens":["100"],"X-RateLimit-Remaining-Tokens":["25"]},"body":"not returned to browser"}`), nil
	})

	result, err := service.XAI(context.Background(), "xai-user.json")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || len(result.Windows) != 1 || result.Windows[0].Label != "grok-4.3 token rate limit" || *result.Windows[0].RemainingPercent != 25 {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestXAIRejectsInvalidAuthIndexBeforeNetwork(t *testing.T) {
	manager := managerconfig.New(config.Config{CPAUpstreamURL: "http://cpa.internal", ManagementKey: "key"}, nil, nil)
	service := New(manager, "", "", []string{"grok-4.7"})
	if _, err := service.XAI(context.Background(), "bad\nindex"); err == nil {
		t.Fatal("expected validation error")
	}
}

func TestDeepSeekUsesFixedOriginAndReturnsUSDTotalBalance(t *testing.T) {
	service := New(nil, "", "secret-deepseek-key", nil)
	service.client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Method != http.MethodGet || req.URL.String() != deepSeekBalanceURL {
			t.Fatalf("request = %s %s", req.Method, req.URL)
		}
		if req.Header.Get("Authorization") != "Bearer secret-deepseek-key" {
			t.Fatal("missing server-side key")
		}
		return jsonResponse(`{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"88.00"},{"currency":"USD","total_balance":"12.34"}]}`), nil
	})

	result, err := service.DeepSeek(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Currency != "USD" || result.TotalBalance != 12.34 {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestDeepSeekReturnsZeroBalanceWithoutError(t *testing.T) {
	service := New(nil, "", "secret-deepseek-key", nil)
	service.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return jsonResponse(`{"is_available":true,"balance_infos":[{"currency":"usd","total_balance":"0.00"}]}`), nil
	})

	result, err := service.DeepSeek(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Currency != "USD" || result.TotalBalance != 0 {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestDeepSeekRejectsInvalidUSDBalance(t *testing.T) {
	cases := map[string]string{
		"malformed": `{"balance_infos":[{"currency":"USD","total_balance":"abc"}]}`,
		"negative":  `{"balance_infos":[{"currency":"USD","total_balance":"-1.00"}]}`,
		"infinite":  `{"balance_infos":[{"currency":"USD","total_balance":"1e999"}]}`,
		"missing":   `{"balance_infos":[{"currency":"USD"}]}`,
		"no_usd":    `{"balance_infos":[{"currency":"CNY","total_balance":"88.00"}]}`,
		"empty":     `{"balance_infos":[]}`,
		"not_json":  `<html>gateway error</html>`,
	}
	for name, body := range cases {
		service := New(nil, "", "secret-deepseek-key", nil)
		service.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
			return jsonResponse(body), nil
		})
		result, err := service.DeepSeek(context.Background())
		if err == nil {
			t.Fatalf("%s: expected error", name)
		}
		if result.Currency != "" || result.TotalBalance != 0 {
			t.Fatalf("%s: unexpected partial result: %#v", name, result)
		}
		if strings.Contains(err.Error(), "secret-deepseek-key") {
			t.Fatalf("%s: secret leaked in error", name)
		}
	}
}

func TestDeepSeekSurfacesUpstreamStatusWithoutKeyOrBody(t *testing.T) {
	service := New(nil, "", "secret-deepseek-key", nil)
	service.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusUnauthorized, Body: io.NopCloser(strings.NewReader(`{"error":{"id":"auth-failed","message":"Bearer secret-deepseek-key is invalid"}}`)), Header: make(http.Header)}, nil
	})

	_, err := service.DeepSeek(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "HTTP 401") {
		t.Fatalf("expected HTTP status in error, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "secret-deepseek-key") || strings.Contains(err.Error(), "auth-failed") {
		t.Fatalf("leaked upstream detail: %q", err.Error())
	}
}

func TestDeepSeekRequiresConfiguredKey(t *testing.T) {
	service := New(nil, "", "", nil)
	if _, err := service.DeepSeek(context.Background()); !errors.Is(err, ErrDeepSeekNotConfigured) {
		t.Fatalf("expected not-configured error, got %v", err)
	}
}
