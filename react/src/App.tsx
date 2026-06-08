/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0
 */

/**
 * App.tsx - Main CloudXR React Application
 *
 * Modified for BlendedXR:
 * - Move/Scale/Rotate tool modes
 * - Reset Stage button
 * - Play / Pause timeline button
 * - Stop timeline button
 * - Right controller trigger grab detection
 * - Sends controller pose messages to Kit over CloudXR MessageChannel
 */

import { checkCapabilities } from '@helpers/BrowserCapabilities';
import { getDeviceProfile, resolveDeviceProfileId } from '@helpers/DeviceProfiles';
import { loadIWERIfNeeded } from '@helpers/LoadIWER';
import { overridePressureObserver } from '@helpers/overridePressureObserver';
import { kPerformanceOptions } from '@helpers/PerformanceProfiles';
import CloudXRComponent from '@helpers/react/CloudXRComponent';
import { SimpleEnvironment } from '@helpers/react/SimpleEnvironment';
import * as CloudXR from '@nvidia/cloudxr';
import { getResolutionValidationError } from '@nvidia/cloudxr';
import { signal, computed } from '@preact/signals-react';
import { Canvas, useFrame } from '@react-three/fiber';
import { setPreferredColorScheme } from '@react-three/uikit';
import { XR, createXRStore, noEvents, PointerEvents, XROrigin } from '@react-three/xr';
import { useState, useMemo, useEffect, useRef, useCallback } from 'react';

import { CloudXR2DUI } from './CloudXR2DUI';
import CloudXR3DUI from './CloudXRUI';

// Override PressureObserver early to catch errors from buggy browser implementations.
overridePressureObserver();

setPreferredColorScheme('dark');

// Performance metrics signals - raw data from CloudXRComponent callbacks.
const renderMetrics = signal<{ fps: number } | null>(null);
const streamingMetrics = signal<{ fps: number; latencyMs: number } | null>(null);

const renderFpsText = computed(() =>
  renderMetrics.value ? renderMetrics.value.fps.toFixed(1) : '-'
);

const streamingFpsText = computed(() =>
  streamingMetrics.value ? streamingMetrics.value.fps.toFixed(1) : '-'
);

const poseToRenderText = computed(() =>
  streamingMetrics.value ? `${streamingMetrics.value.latencyMs.toFixed(1)}ms` : '-'
);

type ToolMode = 'view' | 'moveStage' | 'scaleStage' | 'rotateStage';

type ControllerPosePayload = {
  position: [number, number, number];
  rotation: [number, number, number, number];
};

const RIGHT_TRIGGER_BUTTON_INDEX = 0;
const CONTROLLER_UPDATE_INTERVAL_MS = 50; // 20 Hz

type XRInputSourceWithGamepad = XRInputSource & {
  gamepad?: Gamepad;
};

function StageControllerInput({
  toolMode,
  sendMessage,
}: {
  toolMode: ToolMode;
  sendMessage: (message: any) => Promise<boolean>;
}) {
  const grabbingRef = useRef(false);
  const lastSendTimeRef = useRef(0);

  const getRightController = (session: XRSession): XRInputSourceWithGamepad | null => {
    for (const source of Array.from(session.inputSources) as XRInputSourceWithGamepad[]) {
      if (source.handedness === 'right' && source.gripSpace && source.gamepad) {
        return source;
      }
    }

    return null;
  };

  const getTriggerPressed = (source: XRInputSourceWithGamepad): boolean => {
    const button = source.gamepad?.buttons?.[RIGHT_TRIGGER_BUTTON_INDEX];

    if (!button) {
      return false;
    }

    // Some browsers set pressed, others are more reliable with analog value.
    return button.pressed || button.value > 0.75;
  };

  const makePosePayload = (
    frame: XRFrame,
    source: XRInputSourceWithGamepad,
    referenceSpace: XRReferenceSpace
  ): ControllerPosePayload | null => {
    if (!source.gripSpace) {
      return null;
    }

    const pose = frame.getPose(source.gripSpace, referenceSpace);

    if (!pose) {
      return null;
    }

    const p = pose.transform.position;
    const q = pose.transform.orientation;

    return {
      position: [p.x, p.y, p.z],
      rotation: [q.x, q.y, q.z, q.w],
    };
  };

  useFrame((state, _delta, frame) => {
    // If we leave the tool mode while grabbing, end the grab cleanly.
    if (!frame || toolMode === 'view') {
      if (grabbingRef.current) {
        grabbingRef.current = false;

        void sendMessage({
          type: 'bxr.endStageGrab',
          payload: {},
        });
      }

      return;
    }

    const xrManager = state.gl.xr;
    const session = xrManager.getSession();
    const referenceSpace = xrManager.getReferenceSpace();

    if (!session || !referenceSpace) {
      return;
    }

    const rightController = getRightController(session);

    if (!rightController) {
      return;
    }

    const triggerPressed = getTriggerPressed(rightController);
    const posePayload = makePosePayload(frame, rightController, referenceSpace);

    if (!posePayload) {
      return;
    }

    if (triggerPressed && !grabbingRef.current) {
      grabbingRef.current = true;
      lastSendTimeRef.current = performance.now();

      void sendMessage({
        type: 'bxr.beginStageGrab',
        payload: {
          mode: toolMode,
          pose: posePayload,
        },
      });

      return;
    }

    if (triggerPressed && grabbingRef.current) {
      const now = performance.now();

      if (now - lastSendTimeRef.current < CONTROLLER_UPDATE_INTERVAL_MS) {
        return;
      }

      lastSendTimeRef.current = now;

      void sendMessage({
        type: 'bxr.updateStageGrab',
        payload: {
          mode: toolMode,
          pose: posePayload,
        },
      });

      return;
    }

    if (!triggerPressed && grabbingRef.current) {
      grabbingRef.current = false;

      void sendMessage({
        type: 'bxr.endStageGrab',
        payload: {},
      });
    }
  });

  return null;
}

function App() {
  // 2D UI management
  const [cloudXR2DUI, setCloudXR2DUI] = useState<CloudXR2DUI | null>(null);

  // IWER loading state
  const [iwerLoaded, setIwerLoaded] = useState(false);

  // Capability state management
  const [capabilitiesValid, setCapabilitiesValid] = useState(false);
  const capabilitiesCheckedRef = useRef(false);

  // Session status management
  const [sessionStatus, setSessionStatus] = useState('Disconnected');

  // Error message management
  const [errorMessage, setErrorMessage] = useState('');

  // CloudXR session reference
  const [cloudXRSession, setCloudXRSession] = useState<CloudXR.Session | null>(null);

  // XR mode state for UI visibility
  const [isXRMode, setIsXRMode] = useState(false);

  // Server address being used for connection
  const [serverAddress, setServerAddress] = useState<string>('');

  // BlendedXR tool mode state
  const [toolMode, setToolMode] = useState<ToolMode>('view');
  const toolModeRef = useRef<ToolMode>('view');

  // Load IWER first.
  // Note: React Three Fiber's emulation is disabled to avoid conflicts.
  useEffect(() => {
    const loadIWER = async () => {
      const { supportsImmersive, iwerLoaded: wasIwerLoaded } = await loadIWERIfNeeded();

      if (!supportsImmersive) {
        setErrorMessage('Immersive mode not supported');
        setIwerLoaded(false);
        setCapabilitiesValid(false);
        capabilitiesCheckedRef.current = false;
        return;
      }

      setIwerLoaded(true);

      if (wasIwerLoaded) {
        sessionStorage.setItem('iwerWasLoaded', 'true');
      }
    };

    loadIWER();
  }, []);

  // Update button state when IWER fails and UI becomes ready.
  useEffect(() => {
    if (cloudXR2DUI && !iwerLoaded && !capabilitiesValid) {
      cloudXR2DUI.setStartButtonState(true, 'CONNECT (immersive mode not supported)');
    }
  }, [cloudXR2DUI, iwerLoaded, capabilitiesValid]);

  // Check capabilities once CloudXR2DUI is ready and IWER is loaded.
  useEffect(() => {
    const checkCapabilitiesOnce = async () => {
      if (!cloudXR2DUI || !iwerLoaded) {
        return;
      }

      if (capabilitiesCheckedRef.current) {
        return;
      }

      capabilitiesCheckedRef.current = true;
      cloudXR2DUI.setStartButtonState(true, 'CONNECT (checking capabilities)');

      let result: { success: boolean; failures: string[]; warnings: string[] } = {
        success: false,
        failures: [],
        warnings: [],
      };

      try {
        result = await checkCapabilities();
      } catch (error) {
        cloudXR2DUI.showStatus(`Capability check error: ${error}`, 'error');
        setCapabilitiesValid(false);
        cloudXR2DUI.setStartButtonState(true, 'CONNECT (capability check failed)');
        capabilitiesCheckedRef.current = false;
        return;
      }

      if (!result.success) {
        cloudXR2DUI.showStatus(
          'Browser does not meet required capabilities:\n' + result.failures.join('\n'),
          'error'
        );
        setCapabilitiesValid(false);
        cloudXR2DUI.setStartButtonState(true, 'CONNECT (capability check failed)');
        capabilitiesCheckedRef.current = false;
        return;
      }

      const iwerWasLoaded = sessionStorage.getItem('iwerWasLoaded') === 'true';

      if (result.warnings.length > 0) {
        cloudXR2DUI.showStatus('Performance notice:\n' + result.warnings.join('\n'), 'info');
      } else if (iwerWasLoaded) {
        cloudXR2DUI.showStatus(
          'CloudXR.js SDK is supported.\nUsing IWER (Immersive Web Emulator Runtime) - Emulating Meta Quest 3.',
          'info'
        );
      } else {
        cloudXR2DUI.showStatus('CloudXR.js SDK is supported.', 'success');
      }

      setCapabilitiesValid(true);
      cloudXR2DUI.setStartButtonState(false, 'CONNECT');
      cloudXR2DUI.updateConnectButtonState();
    };

    checkCapabilitiesOnce();
  }, [cloudXR2DUI, iwerLoaded]);

  // Track config changes to trigger re-renders when form values change.
  const [configVersion, setConfigVersion] = useState(0);

  const deviceProfile = useMemo(
    () => getDeviceProfile(resolveDeviceProfileId(cloudXR2DUI?.getConfiguration().deviceProfileId)),
    [cloudXR2DUI, configVersion]
  );

  const xrFoveation =
    deviceProfile.web?.foveation ?? kPerformanceOptions.xrWebGLLayer_fixedFoveationLevel;

  const xrFrameBufferScaling =
    deviceProfile.web?.frameBufferScaling ??
    kPerformanceOptions.xrWebGLLayer_framebufferScaleFactor;

  // XR store must be created after we know which device profile is active.
  const store = useMemo(
    () =>
      createXRStore({
        emulate: false,
        foveation: xrFoveation,
        frameBufferScaling: xrFrameBufferScaling,

        ...(process.env.WEBXR_ASSETS_VERSION && {
          baseAssetPath: `${new URL('.', window.location).href}npm/@webxr-input-profiles/assets@${process.env.WEBXR_ASSETS_VERSION}/dist/profiles/`,
        }),

        hand: {
          model: false,
        },

        handTracking: true,
        bodyTracking: true,

        anchors: false,
        layers: false,
        meshDetection: false,
        planeDetection: false,
        depthSensing: false,
        domOverlay: false,
        hitTest: false,

        offerSession: true,
      }),
    [xrFoveation, xrFrameBufferScaling]
  );

  // Initialize CloudXR2DUI.
  useEffect(() => {
    const ui = new CloudXR2DUI(() => {
      setConfigVersion(v => v + 1);
    });

    ui.initialize();

    ui.setupConnectButtonHandler(
      async () => {
        const config = ui.getConfiguration();
        const resolutionError = getResolutionValidationError(
          config.perEyeWidth,
          config.perEyeHeight
        );

        if (resolutionError) {
          ui.updateConnectButtonState();
          return;
        }

        if (config.immersiveMode === 'ar') {
          await store.enterAR();
        } else if (ui.getConfiguration().immersiveMode === 'vr') {
          await store.enterVR();
        } else {
          setErrorMessage('Unrecognized immersive mode');
        }

        store.setFrameRate((supportedFrameRates: ArrayLike<number>): number | false => {
          const frameRate = ui.getConfiguration().deviceFrameRate;

          let found = false;

          for (let i = 0; i < supportedFrameRates.length; ++i) {
            if (supportedFrameRates[i] === frameRate) {
              found = true;
              break;
            }
          }

          if (found) {
            console.info('Requested frame rate', frameRate, 'is supported; requested it.');
            return frameRate;
          }

          console.warn('Requested frame rate', frameRate, 'is not supported; using default.');
          return false;
        });
      },
      (error: Error) => {
        setErrorMessage(`Failed to start XR session: ${error}`);
      }
    );

    setCloudXR2DUI(ui);

    return () => {
      ui.cleanup();
    };
  }, [store]);

  // Update HTML error message display when error state changes.
  useEffect(() => {
    if (cloudXR2DUI) {
      if (errorMessage) {
        cloudXR2DUI.showError(errorMessage);
      } else {
        cloudXR2DUI.hideError();
      }
    }
  }, [errorMessage, cloudXR2DUI]);

  // Listen for XR session state changes to update button and UI visibility.
  useEffect(() => {
    const handleXRStateChange = () => {
      const xrState = store.getState();

      if (xrState.mode === 'immersive-ar' || xrState.mode === 'immersive-vr') {
        setIsXRMode(true);

        if (cloudXR2DUI) {
          cloudXR2DUI.setStartButtonState(true, 'CONNECT (XR session active)');
        }
      } else {
        setIsXRMode(false);

        if (cloudXR2DUI) {
          cloudXR2DUI.setStartButtonState(false, 'CONNECT');
          cloudXR2DUI.updateConnectButtonState();
        }

        if (xrState.error) {
          setErrorMessage(`XR session error: ${xrState.error}`);
        }
      }
    };

    const unsubscribe = store.subscribe(handleXRStateChange);

    return () => {
      unsubscribe();
      setIsXRMode(false);
    };
  }, [cloudXR2DUI, store]);

  // CloudXR status change handler.
  const handleStatusChange = (_connected: boolean, status: string) => {
    setSessionStatus(status);
  };

  /**
   * Helper to send a message using MessageChannel API or legacy fallback.
   */
  const sendMessage = useCallback(
    async (message: any) => {
      if (!cloudXRSession) {
        console.error('CloudXR session not available');
        return false;
      }

      const channels = cloudXRSession.availableMessageChannels;

      if (channels.length > 0) {
        const channel = channels[0];
        console.log(`Using MessageChannel API (${channels.length} channels available)`);

        try {
          const encoder = new TextEncoder();
          const data = encoder.encode(JSON.stringify(message));
          const success = channel.sendServerMessage(data);

          if (success) {
            console.log('Message sent via MessageChannel:', message);
          } else {
            console.error('Failed to send message via MessageChannel');
          }

          return success;
        } catch (error) {
          console.error('Error sending via MessageChannel:', error);
          return false;
        }
      }

      console.log('Using legacy sendServerMessage API');

      try {
        cloudXRSession.sendServerMessage(message);
        console.log('Message sent via legacy API:', message);
        return true;
      } catch (error) {
        console.error('Error sending via legacy API:', error);
        return false;
      }
    },
    [cloudXRSession]
  );

  const setMode = async (mode: ToolMode) => {
    const nextMode: ToolMode = toolModeRef.current === mode ? 'view' : mode;

    toolModeRef.current = nextMode;
    setToolMode(nextMode);

    await sendMessage({
      type: 'bxr.setToolMode',
      payload: {
        mode: nextMode,
      },
    });
  };

  const handleMoveMode = async () => {
    await setMode('moveStage');
  };

  const handleScaleMode = async () => {
    await setMode('scaleStage');
  };

  const handleRotateMode = async () => {
    await setMode('rotateStage');
  };

  const handleResetStage = async () => {
    toolModeRef.current = 'view';
    setToolMode('view');

    await sendMessage({
      type: 'bxr.resetStageTransform',
      payload: {},
    });
  };

  const handleToggleTimeline = async () => {
    await sendMessage({
      type: 'bxr.toggleTimeline',
      payload: {},
    });
  };

  const handleStopTimeline = async () => {
    await sendMessage({
      type: 'bxr.stopTimeline',
      payload: {},
    });
  };

  const handleDisconnect = () => {
    console.log('Disconnect pressed');

    const xrState = store.getState();
    const session = xrState.session;

    if (session) {
      session.end().catch((err: unknown) => {
        setErrorMessage(
          `Failed to end XR session: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  };

  const handleRenderPerformanceMetrics = (fps: number) => {
    renderMetrics.value = { fps };
  };

  const handleStreamingPerformanceMetrics = (fps: number, latencyMs: number) => {
    streamingMetrics.value = { fps, latencyMs };
  };

  const config = useMemo(
    () => (cloudXR2DUI ? cloudXR2DUI.getConfiguration() : null),
    [cloudXR2DUI, configVersion]
  );

  // Sync XR mode state to body class for CSS styling.
  useEffect(() => {
    if (isXRMode) {
      document.body.classList.add('xr-mode');
    } else {
      document.body.classList.remove('xr-mode');
    }

    return () => {
      document.body.classList.remove('xr-mode');
    };
  }, [isXRMode]);

  // Set up message receiving from MessageChannel.
  useEffect(() => {
    if (!cloudXRSession) {
      return;
    }

    let active = true;
    let receiverActive = false;

    const checkAndSetupReceiver = () => {
      if (!active || receiverActive) {
        return;
      }

      const channels = cloudXRSession.availableMessageChannels;

      if (channels.length > 0) {
        const channel = channels[0];
        console.log('Setting up MessageChannel receiver');
        receiverActive = true;

        const receiveMessages = async () => {
          while (active) {
            try {
              const data = await channel.receiveMessage();

              if (data === null) {
                console.log('MessageChannel closed');
                break;
              }

              const decoder = new TextDecoder();
              const messageText = decoder.decode(data);

              console.log('Received message via MessageChannel:', messageText);

              try {
                const message = JSON.parse(messageText);
                console.log('Parsed message:', message);
              } catch {
                console.log('Non-JSON message:', messageText);
              }
            } catch (error) {
              console.error('Error receiving message:', error);
              break;
            }
          }
        };

        receiveMessages();
      }
    };

    checkAndSetupReceiver();

    const pollInterval = setInterval(checkAndSetupReceiver, 1000);

    return () => {
      active = false;
      clearInterval(pollInterval);
    };
  }, [cloudXRSession]);

  return (
    <>
      <Canvas
        events={noEvents}
        style={{
          background: '#000',
          width: '100vw',
          height: '100vh',
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: -1,
        }}
        gl={{
          alpha: true,
          depth: true,
          stencil: false,
          antialias:
            deviceProfile.web?.webglAntialias ?? kPerformanceOptions.webglContext_antialias,
          desynchronized: false,
          failIfMajorPerformanceCaveat: true,
          powerPreference: deviceProfile.web?.powerPreference ?? 'high-performance',
          premultipliedAlpha: false,
          preserveDrawingBuffer: true,
        }}
        camera={{ position: [0, 0, 0.65] }}
        onWheel={e => {
          e.preventDefault();
        }}
      >
        <PointerEvents batchEvents={false} />

        <XR store={store}>
          <SimpleEnvironment />
          <XROrigin />

          <StageControllerInput toolMode={toolMode} sendMessage={sendMessage} />

          {cloudXR2DUI && config && (
            <>
              <CloudXRComponent
                config={config}
                applicationName="CloudXR React Example"
                onStatusChange={handleStatusChange}
                onError={error => {
                  if (cloudXR2DUI) {
                    cloudXR2DUI.showError(error);
                  }
                }}
                onSessionReady={setCloudXRSession}
                onServerAddress={setServerAddress}
                onRenderPerformanceMetrics={handleRenderPerformanceMetrics}
                onStreamingPerformanceMetrics={handleStreamingPerformanceMetrics}
              />

              <CloudXR3DUI
                onMoveMode={handleMoveMode}
                onScaleMode={handleScaleMode}
                onRotateMode={handleRotateMode}
                onResetStage={handleResetStage}
                onToggleTimeline={handleToggleTimeline}
                onStopTimeline={handleStopTimeline}
                onDisconnect={handleDisconnect}
                toolMode={toolMode}
                serverAddress={serverAddress || config.serverIP}
                sessionStatus={sessionStatus}
                renderFpsText={renderFpsText}
                streamingFpsText={streamingFpsText}
                poseToRenderText={poseToRenderText}
                position={[0, 1.6, -1.8]}
                rotation={[0, 0, 0]}
              />
            </>
          )}
        </XR>
      </Canvas>
    </>
  );
}

export default App;