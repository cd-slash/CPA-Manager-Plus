package providerusage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
)

const (
	zaiQuotaURL        = "https://api.z.ai/api/monitor/usage/quota/limit"
	xaiCompletionsURL  = "https://api.x.ai/v1/chat/completions"
	deepSeekBalanceURL = "https://api.deepseek.com/user/balance"
	maxResponseBytes   = 1 << 20
)

type Service struct {
	managerConfig  *managerconfig.Service
	zaiAPIKey      string
	deepSeekAPIKey string
	xaiModels      []string
	client         *http.Client
}

type Window struct {
	ID               string   `json:"id"`
	Label            string   `json:"label"`
	RemainingPercent *float64 `json:"remainingPercent"`
	ResetAtMS        *int64   `json:"resetAtMs"`
	LimitTokens      *float64 `json:"limitTokens,omitempty"`
	RemainingTokens  *float64 `json:"remainingTokens,omitempty"`
}

type ZAIResult struct {
	Plan    string   `json:"plan,omitempty"`
	Windows []Window `json:"windows"`
}

type XAIResult struct {
	Windows []Window `json:"windows"`
}

// DeepSeekResult carries the sanitized USD balance only. The API key and the
// raw upstream response never leave the server.
type DeepSeekResult struct {
	Currency     string  `json:"currency"`
	TotalBalance float64 `json:"totalBalance"`
}

func New(managerConfig *managerconfig.Service, zaiAPIKey string, deepSeekAPIKey string, xaiModels []string) *Service {
	models := make([]string, 0, len(xaiModels))
	for _, model := range xaiModels {
		if model = strings.TrimSpace(model); model != "" {
			models = append(models, model)
		}
	}
	return &Service{managerConfig: managerConfig, zaiAPIKey: strings.TrimSpace(zaiAPIKey), deepSeekAPIKey: strings.TrimSpace(deepSeekAPIKey), xaiModels: models, client: &http.Client{Timeout: 20 * time.Second}}
}

func (s *Service) ZAI(ctx context.Context) (ZAIResult, error) {
	if s.zaiAPIKey == "" {
		return ZAIResult{}, errors.New("Z.AI quota is not configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, zaiQuotaURL, nil)
	if err != nil {
		return ZAIResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+s.zaiAPIKey)
	res, err := s.client.Do(req)
	if err != nil {
		return ZAIResult{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return ZAIResult{}, fmt.Errorf("Z.AI quota returned HTTP %d", res.StatusCode)
	}
	var envelope struct {
		Data struct {
			Level  string `json:"level"`
			Limits []struct {
				Unit          *float64 `json:"unit"`
				Number        *float64 `json:"number"`
				Percentage    *float64 `json:"percentage"`
				NextResetTime any      `json:"nextResetTime"`
			} `json:"limits"`
		} `json:"data"`
	}
	if err := decodeJSON(res.Body, &envelope); err != nil {
		return ZAIResult{}, err
	}
	windows := make([]Window, 0, len(envelope.Data.Limits))
	for index, limit := range envelope.Data.Limits {
		if limit.Unit == nil || limit.Percentage == nil {
			continue
		}
		label := ""
		switch *limit.Unit {
		case 3:
			if limit.Number == nil || *limit.Number <= 0 {
				label = "Rolling limit"
			} else {
				label = fmt.Sprintf("%g-hour limit", *limit.Number)
			}
		case 6:
			label = "Weekly limit"
		default:
			continue
		}
		remaining := clamp(100 - *limit.Percentage)
		reset := parseReset(limit.NextResetTime)
		windows = append(windows, Window{ID: fmt.Sprintf("zai-%g-%d", *limit.Unit, index), Label: label, RemainingPercent: &remaining, ResetAtMS: reset})
	}
	if len(windows) == 0 {
		return ZAIResult{}, errors.New("Z.AI returned no quota windows")
	}
	return ZAIResult{Plan: strings.TrimSpace(envelope.Data.Level), Windows: windows}, nil
}

// ErrDeepSeekNotConfigured marks a deployment without CPA_MANAGER_DEEPSEEK_API_KEY.
var ErrDeepSeekNotConfigured = errors.New("DeepSeek balance is not configured")

// DeepSeek queries the fixed DeepSeek balance endpoint with the server-held
// API key and returns the USD balance_infos total_balance. Errors never
// include the key or the upstream response body.
func (s *Service) DeepSeek(ctx context.Context) (DeepSeekResult, error) {
	if s.deepSeekAPIKey == "" {
		return DeepSeekResult{}, ErrDeepSeekNotConfigured
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, deepSeekBalanceURL, nil)
	if err != nil {
		return DeepSeekResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+s.deepSeekAPIKey)
	res, err := s.client.Do(req)
	if err != nil {
		return DeepSeekResult{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return DeepSeekResult{}, fmt.Errorf("DeepSeek balance returned HTTP %d", res.StatusCode)
	}
	var envelope struct {
		BalanceInfos []struct {
			Currency     string `json:"currency"`
			TotalBalance string `json:"total_balance"`
		} `json:"balance_infos"`
	}
	if err := decodeJSON(res.Body, &envelope); err != nil {
		return DeepSeekResult{}, errors.New("DeepSeek returned an unreadable balance response")
	}
	for _, info := range envelope.BalanceInfos {
		if !strings.EqualFold(strings.TrimSpace(info.Currency), "USD") {
			continue
		}
		balance, err := parseUSDBalance(info.TotalBalance)
		if err != nil {
			return DeepSeekResult{}, err
		}
		return DeepSeekResult{Currency: "USD", TotalBalance: balance}, nil
	}
	return DeepSeekResult{}, errors.New("DeepSeek returned no USD balance")
}

func parseUSDBalance(raw string) (float64, error) {
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, errors.New("DeepSeek returned an invalid USD balance")
	}
	if value < 0 {
		return 0, errors.New("DeepSeek returned a negative USD balance")
	}
	return value, nil
}

func (s *Service) XAI(ctx context.Context, authIndex string) (XAIResult, error) {
	authIndex = strings.TrimSpace(authIndex)
	if authIndex == "" || len(authIndex) > 512 || strings.ContainsAny(authIndex, "\r\n") {
		return XAIResult{}, errors.New("invalid auth_index")
	}
	setup, ok, err := s.managerConfig.ResolveSetup(ctx)
	if err != nil {
		return XAIResult{}, err
	}
	if !ok {
		return XAIResult{}, errors.New("usage service is not configured")
	}
	windows := make([]Window, 0, len(s.xaiModels))
	for _, model := range s.xaiModels {
		requestData, _ := json.Marshal(map[string]any{"model": model, "messages": []map[string]string{{"role": "user", "content": "ping"}}, "max_tokens": 1})
		payload, _ := json.Marshal(map[string]any{"authIndex": authIndex, "method": http.MethodPost, "url": xaiCompletionsURL, "header": map[string]string{"Authorization": "Bearer $TOKEN$", "Content-Type": "application/json"}, "data": string(requestData)})
		req, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(setup.CPAUpstreamURL, "/")+"/v0/management/api-call", bytes.NewReader(payload))
		if reqErr != nil {
			continue
		}
		req.Header.Set("Authorization", "Bearer "+setup.ManagementKey)
		req.Header.Set("Content-Type", "application/json")
		res, callErr := s.client.Do(req)
		if callErr != nil {
			continue
		}
		var result struct {
			StatusCode      int                 `json:"status_code"`
			StatusCodeCamel int                 `json:"statusCode"`
			Header          map[string][]string `json:"header"`
			Headers         map[string][]string `json:"headers"`
		}
		decodeErr := decodeJSON(res.Body, &result)
		res.Body.Close()
		statusCode := result.StatusCode
		if statusCode == 0 {
			statusCode = result.StatusCodeCamel
		}
		headers := result.Header
		if len(headers) == 0 {
			headers = result.Headers
		}
		if decodeErr != nil || res.StatusCode < 200 || res.StatusCode >= 300 || statusCode < 200 || statusCode >= 300 {
			continue
		}
		limit := headerNumber(headers, "x-ratelimit-limit-tokens")
		remaining := headerNumber(headers, "x-ratelimit-remaining-tokens")
		if limit == nil || remaining == nil || *limit <= 0 {
			continue
		}
		percent := clamp(*remaining / *limit * 100)
		windows = append(windows, Window{ID: "xai-ratelimit-" + model, Label: model + " token rate limit", RemainingPercent: &percent, LimitTokens: limit, RemainingTokens: remaining})
	}
	if len(windows) == 0 {
		return XAIResult{}, errors.New("xAI returned no rate-limit windows")
	}
	return XAIResult{Windows: windows}, nil
}

func decodeJSON(r io.Reader, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r, maxResponseBytes))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return nil
}

func clamp(value float64) float64 { return math.Min(100, math.Max(0, value)) }

func headerNumber(headers map[string][]string, name string) *float64 {
	for key, values := range headers {
		if strings.EqualFold(key, name) && len(values) > 0 {
			var value float64
			if _, err := fmt.Sscan(strings.TrimSpace(values[0]), &value); err == nil && math.IsNaN(value) == false && math.IsInf(value, 0) == false && value >= 0 {
				return &value
			}
		}
	}
	return nil
}

func parseReset(value any) *int64 {
	switch typed := value.(type) {
	case float64:
		ms := int64(typed)
		if ms < 1_000_000_000_000 {
			ms *= 1000
		}
		return &ms
	case string:
		if parsed, err := time.Parse(time.RFC3339, typed); err == nil {
			ms := parsed.UnixMilli()
			return &ms
		}
	}
	return nil
}
