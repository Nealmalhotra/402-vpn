package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
)

const peerEventAckChannel = "peer_events:ack"

type Config struct {
	RedisURL    string
	Region      string
	WGInterface string
	WGBinary    string
	DryRun      bool
}

type PeerEvent struct {
	Type       string `json:"type"`
	SessionID  string `json:"session_id"`
	Region     string `json:"region"`
	PublicKey  string `json:"public_key"`
	AssignedIP string `json:"assigned_ip"`
	OccurredAt int64  `json:"occurred_at"`
}

type PeerEventAck struct {
	Type       string `json:"type"`
	SessionID  string `json:"session_id"`
	Region     string `json:"region"`
	Status     string `json:"status"`
	Message    string `json:"message,omitempty"`
	OccurredAt int64  `json:"occurred_at"`
}

type Agent struct {
	config Config
	redis  *redis.Client
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func boolFromEnv(name string) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
	return value == "1" || value == "true" || value == "yes"
}

func loadConfig() (Config, error) {
	region := strings.TrimSpace(os.Getenv("AGENT_REGION"))
	if region == "" {
		return Config{}, fmt.Errorf("AGENT_REGION is required")
	}

	return Config{
		RedisURL:    envOrDefault("REDIS_URL", "redis://127.0.0.1:6379"),
		Region:      region,
		WGInterface: envOrDefault("WG_INTERFACE", "wg0"),
		WGBinary:    envOrDefault("WG_BIN", "wg"),
		DryRun:      boolFromEnv("AGENT_DRY_RUN"),
	}, nil
}

func peerEventsChannel(region string) string {
	return fmt.Sprintf("peer_events:%s", region)
}

func regionActivePeersKey(region string) string {
	return fmt.Sprintf("region:%s:active_peers", region)
}

func regionIPPoolKey(region string) string {
	return fmt.Sprintf("region:%s:ip_pool", region)
}

func sessionKey(sessionID string) string {
	return fmt.Sprintf("session:%s", sessionID)
}

func normalizeAllowedIP(ip string) string {
	if strings.Contains(ip, "/") {
		return ip
	}
	return ip + "/32"
}

func (a *Agent) runWG(args ...string) error {
	if a.config.DryRun {
		log.Printf("[agent] dry-run %s %s", a.config.WGBinary, strings.Join(args, " "))
		return nil
	}

	cmd := exec.Command(a.config.WGBinary, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("wg command failed (%v): %s", err, strings.TrimSpace(string(output)))
	}

	return nil
}

func (a *Agent) publishAck(ctx context.Context, ack PeerEventAck) {
	payload, err := json.Marshal(ack)
	if err != nil {
		log.Printf("[agent] failed to marshal ack: %v", err)
		return
	}

	if err := a.redis.Publish(ctx, peerEventAckChannel, string(payload)).Err(); err != nil {
		log.Printf("[agent] failed to publish ack: %v", err)
	}
}

func (a *Agent) fetchSessionPeerInfo(ctx context.Context, sessionID string) (pubKey string, assignedIP string, status string, err error) {
	values, err := a.redis.HGetAll(ctx, sessionKey(sessionID)).Result()
	if err != nil {
		return "", "", "", err
	}
	if len(values) == 0 {
		return "", "", "", fmt.Errorf("session not found in redis: %s", sessionID)
	}

	return values["public_key"], values["assigned_ip"], values["status"], nil
}

func (a *Agent) handlePeerAdd(ctx context.Context, event PeerEvent) {
	pubKey := event.PublicKey
	assignedIP := event.AssignedIP

	if pubKey == "" || assignedIP == "" {
		resolvedPubKey, resolvedIP, _, err := a.fetchSessionPeerInfo(ctx, event.SessionID)
		if err != nil {
			a.publishAck(ctx, PeerEventAck{
				Type:       "PEER_ADD_ACK",
				SessionID:  event.SessionID,
				Region:     a.config.Region,
				Status:     "error",
				Message:    err.Error(),
				OccurredAt: time.Now().Unix(),
			})
			return
		}
		pubKey = resolvedPubKey
		assignedIP = resolvedIP
	}

	if pubKey == "" || assignedIP == "" {
		a.publishAck(ctx, PeerEventAck{
			Type:       "PEER_ADD_ACK",
			SessionID:  event.SessionID,
			Region:     a.config.Region,
			Status:     "error",
			Message:    "missing public_key or assigned_ip",
			OccurredAt: time.Now().Unix(),
		})
		return
	}

	err := a.runWG("set", a.config.WGInterface, "peer", pubKey, "allowed-ips", normalizeAllowedIP(assignedIP))
	if err != nil {
		a.publishAck(ctx, PeerEventAck{
			Type:       "PEER_ADD_ACK",
			SessionID:  event.SessionID,
			Region:     a.config.Region,
			Status:     "error",
			Message:    err.Error(),
			OccurredAt: time.Now().Unix(),
		})
		return
	}

	if err := a.redis.SAdd(ctx, regionActivePeersKey(a.config.Region), event.SessionID).Err(); err != nil {
		log.Printf("[agent] failed to add session to active peers set: %v", err)
	}

	a.publishAck(ctx, PeerEventAck{
		Type:       "PEER_ADD_ACK",
		SessionID:  event.SessionID,
		Region:     a.config.Region,
		Status:     "ok",
		OccurredAt: time.Now().Unix(),
	})
}

func (a *Agent) handlePeerEvict(ctx context.Context, event PeerEvent) {
	pubKey := event.PublicKey
	assignedIP := event.AssignedIP

	if pubKey == "" || assignedIP == "" {
		resolvedPubKey, resolvedIP, _, err := a.fetchSessionPeerInfo(ctx, event.SessionID)
		if err != nil {
			a.publishAck(ctx, PeerEventAck{
				Type:       "PEER_EVICT_ACK",
				SessionID:  event.SessionID,
				Region:     a.config.Region,
				Status:     "error",
				Message:    err.Error(),
				OccurredAt: time.Now().Unix(),
			})
			return
		}
		pubKey = resolvedPubKey
		assignedIP = resolvedIP
	}

	if pubKey == "" {
		a.publishAck(ctx, PeerEventAck{
			Type:       "PEER_EVICT_ACK",
			SessionID:  event.SessionID,
			Region:     a.config.Region,
			Status:     "error",
			Message:    "missing public_key",
			OccurredAt: time.Now().Unix(),
		})
		return
	}

	err := a.runWG("set", a.config.WGInterface, "peer", pubKey, "remove")
	if err != nil {
		a.publishAck(ctx, PeerEventAck{
			Type:       "PEER_EVICT_ACK",
			SessionID:  event.SessionID,
			Region:     a.config.Region,
			Status:     "error",
			Message:    err.Error(),
			OccurredAt: time.Now().Unix(),
		})
		return
	}

	if err := a.redis.SRem(ctx, regionActivePeersKey(a.config.Region), event.SessionID).Err(); err != nil {
		log.Printf("[agent] failed to remove session from active peers set: %v", err)
	}
	if assignedIP != "" {
		if err := a.redis.SAdd(ctx, regionIPPoolKey(a.config.Region), assignedIP).Err(); err != nil {
			log.Printf("[agent] failed to return IP %s to pool: %v", assignedIP, err)
		}
	}

	a.publishAck(ctx, PeerEventAck{
		Type:       "PEER_EVICT_ACK",
		SessionID:  event.SessionID,
		Region:     a.config.Region,
		Status:     "ok",
		OccurredAt: time.Now().Unix(),
	})
}

func (a *Agent) handleEvent(ctx context.Context, event PeerEvent) {
	if event.Region != "" && event.Region != a.config.Region {
		return
	}

	switch event.Type {
	case "PEER_ADD":
		a.handlePeerAdd(ctx, event)
	case "PEER_EVICT":
		a.handlePeerEvict(ctx, event)
	default:
		log.Printf("[agent] ignoring unknown event type: %s", event.Type)
	}
}

func (a *Agent) resyncFromRedis(ctx context.Context) error {
	sessionIDs, err := a.redis.SMembers(ctx, regionActivePeersKey(a.config.Region)).Result()
	if err != nil {
		return err
	}

	for _, sessionID := range sessionIDs {
		pubKey, assignedIP, status, err := a.fetchSessionPeerInfo(ctx, sessionID)
		if err != nil {
			log.Printf("[agent] resync lookup failed for %s: %v", sessionID, err)
			continue
		}
		if status != "active" || pubKey == "" || assignedIP == "" {
			continue
		}
		if err := a.runWG("set", a.config.WGInterface, "peer", pubKey, "allowed-ips", normalizeAllowedIP(assignedIP)); err != nil {
			log.Printf("[agent] resync apply failed for %s: %v", sessionID, err)
		}
	}

	log.Printf("[agent] resynced %d active peers", len(sessionIDs))
	return nil
}

func (a *Agent) run(ctx context.Context) error {
	if err := a.resyncFromRedis(ctx); err != nil {
		return fmt.Errorf("resync failed: %w", err)
	}

	channel := peerEventsChannel(a.config.Region)
	pubsub := a.redis.Subscribe(ctx, channel)
	defer pubsub.Close()

	if _, err := pubsub.Receive(ctx); err != nil {
		return fmt.Errorf("failed to subscribe to %s: %w", channel, err)
	}

	log.Printf("[agent] subscribed to %s", channel)
	events := pubsub.Channel()

	for {
		select {
		case <-ctx.Done():
			return nil
		case msg := <-events:
			if msg == nil {
				continue
			}

			var event PeerEvent
			if err := json.Unmarshal([]byte(msg.Payload), &event); err != nil {
				log.Printf("[agent] invalid event payload: %v", err)
				continue
			}
			a.handleEvent(ctx, event)
		}
	}
}

func main() {
	config, err := loadConfig()
	if err != nil {
		log.Fatalf("[agent] invalid config: %v", err)
	}

	opts, err := redis.ParseURL(config.RedisURL)
	if err != nil {
		log.Fatalf("[agent] invalid REDIS_URL: %v", err)
	}

	client := redis.NewClient(opts)
	defer client.Close()

	agent := &Agent{
		config: config,
		redis:  client,
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	log.Printf("[agent] region=%s iface=%s dry_run=%t", config.Region, config.WGInterface, config.DryRun)
	if err := agent.run(ctx); err != nil {
		log.Fatalf("[agent] terminated with error: %v", err)
	}

	log.Println("[agent] shutdown complete")
}
