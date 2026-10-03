package providerusage

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/app"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/middleware"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/http/response"
	providerusagesvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/providerusage"
)

type Handler struct{ App *app.Context }

func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	if !middleware.AuthorizePanel(w, r, h.App.AdminAuthService) {
		return
	}
	path := strings.TrimRight(r.URL.Path, "/")
	switch path {
	case "/v0/management/usage-dashboard/zai":
		if r.Method != http.MethodGet {
			response.MethodNotAllowed(w)
			return
		}
		result, err := h.App.ProviderUsageService.ZAI(r.Context())
		if err != nil {
			response.Error(w, http.StatusBadGateway, err)
			return
		}
		response.JSON(w, http.StatusOK, result)
	case "/v0/management/usage-dashboard/deepseek":
		if r.Method != http.MethodGet {
			response.MethodNotAllowed(w)
			return
		}
		result, err := h.App.ProviderUsageService.DeepSeek(r.Context())
		if err != nil {
			// 501 distinguishes "server has no DeepSeek key" from upstream
			// failures so the dashboard can render a truthful state.
			status := http.StatusBadGateway
			if errors.Is(err, providerusagesvc.ErrDeepSeekNotConfigured) {
				status = http.StatusNotImplemented
			}
			response.Error(w, status, err)
			return
		}
		response.JSON(w, http.StatusOK, result)
	case "/v0/management/usage-dashboard/xai":
		if r.Method != http.MethodPost {
			response.MethodNotAllowed(w)
			return
		}
		var body struct {
			AuthIndex string `json:"auth_index"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			response.Error(w, http.StatusBadRequest, err)
			return
		}
		result, err := h.App.ProviderUsageService.XAI(r.Context(), body.AuthIndex)
		if err != nil {
			response.Error(w, http.StatusBadGateway, err)
			return
		}
		response.JSON(w, http.StatusOK, result)
	default:
		http.NotFound(w, r)
	}
}
