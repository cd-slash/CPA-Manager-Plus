package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/testutil"
)

func TestProviderUsageEndpointsRequirePanelAuthorization(t *testing.T) {
	cfg := testutil.NewConfig(t)
	db := testutil.NewStore(t, cfg)
	handler := New(cfg, db, collector.NewManager(cfg, db)).Handler()

	for _, request := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/v0/management/usage-dashboard/zai", ""},
		{http.MethodPost, "/v0/management/usage-dashboard/xai", `{"auth_index":"xai-user.json"}`},
	} {
		req := httptest.NewRequest(request.method, request.path, nil)
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, want 401", request.method, request.path, rr.Code)
		}
	}
}

func TestProviderUsageZAIConfiguredOnlyServerSide(t *testing.T) {
	cfg := testutil.NewConfig(t)
	db := testutil.NewStore(t, cfg)
	handler := New(cfg, db, collector.NewManager(cfg, db)).Handler()
	rr := testutil.Request(t, handler, http.MethodGet, "/v0/management/usage-dashboard/zai", "", testutil.AdminKey)
	if rr.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rr.Code)
	}
}
