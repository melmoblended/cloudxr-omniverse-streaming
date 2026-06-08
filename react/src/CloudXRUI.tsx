/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0
 */

/**
 * CloudXRUI.tsx - CloudXR User Interface Component
 *
 * Modified for BlendedXR:
 * - Move Mode button
 * - Scale Mode button
 * - Rotate Mode button
 * - Reset Stage button
 * - Play / Pause button
 * - Stop button
 * - Disconnect button
 * - Shows current tool mode
 */

import { PerformanceCanvasImage } from '@helpers/react/PerformanceCanvasImage';
import { useXRButton } from '@helpers/react/useXRButton';
import { ReadonlySignal } from '@preact/signals-react';
import { useFrame } from '@react-three/fiber';
import { Handle, HandleTarget } from '@react-three/handle';
import { Container, Text, Image } from '@react-three/uikit';
import { Button } from '@react-three/uikit-default';
import React, { useRef, useEffect } from 'react';
import { Color, Euler, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { damp } from 'three/src/math/MathUtils.js';

const FACE_CAMERA_DAMPING = 10;

const METRIC_SLOT_WIDTH = 512;
const METRIC_SLOT_HEIGHT = 250;

export type ToolMode = 'view' | 'moveStage' | 'scaleStage' | 'rotateStage';

interface CloudXRUIProps {
  onMoveMode?: () => void;
  onScaleMode?: () => void;
  onRotateMode?: () => void;
  onResetStage?: () => void;
  onToggleTimeline?: () => void;
  onStopTimeline?: () => void;
  onDisconnect?: () => void;
  toolMode?: ToolMode;
  serverAddress?: string;
  sessionStatus?: string;
  renderFpsText?: ReadonlySignal<string>;
  streamingFpsText?: ReadonlySignal<string>;
  poseToRenderText?: ReadonlySignal<string>;
  position?: [number, number, number];
  rotation?: [number, number, number];
}

// Reusable objects for face-camera rotation.
const eulerHelper = new Euler();
const quaternionHelper = new Quaternion();
const cameraPositionHelper = new Vector3();
const uiPositionHelper = new Vector3();
const zAxis = new Vector3(0, 0, 1);

const HANDLE_COLOR_DEFAULT = new Color('#666666');
const HANDLE_COLOR_HOVER = new Color('#aaaaaa');

function getToolModeLabel(toolMode: ToolMode): string {
  switch (toolMode) {
    case 'moveStage':
      return 'Move Mode';
    case 'scaleStage':
      return 'Scale Mode';
    case 'rotateStage':
      return 'Rotate Mode';
    case 'view':
    default:
      return 'View Mode';
  }
}

export default function CloudXR3DUI({
  onMoveMode,
  onScaleMode,
  onRotateMode,
  onResetStage,
  onToggleTimeline,
  onStopTimeline,
  onDisconnect,
  toolMode = 'view',
  serverAddress = '127.0.0.1',
  sessionStatus = 'Disconnected',
  renderFpsText,
  streamingFpsText,
  poseToRenderText,
  position = [1.8, 1.75, -1.3],
  rotation = [0, -0.3, 0],
}: CloudXRUIProps) {
  const groupRef = useRef<Group>(null);
  const handleRef = useRef<Mesh>(null);
  const xrButton = useXRButton();

  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.position.set(position[0], position[1], position[2]);
    }
  }, [position[0], position[1], position[2]]);

  // Face-camera rotation: smoothly rotate UI to face the user on Y-axis.
  useFrame((state, dt) => {
    if (groupRef.current === null) {
      return;
    }

    state.camera.getWorldPosition(cameraPositionHelper);
    groupRef.current.getWorldPosition(uiPositionHelper);

    quaternionHelper.setFromUnitVectors(
      zAxis,
      cameraPositionHelper.sub(uiPositionHelper).normalize()
    );

    eulerHelper.setFromQuaternion(quaternionHelper, 'YXZ');

    groupRef.current.rotation.y = damp(
      groupRef.current.rotation.y,
      eulerHelper.y,
      FACE_CAMERA_DAMPING,
      dt
    );
  });

  const moveModeActive = toolMode === 'moveStage';
  const scaleModeActive = toolMode === 'scaleStage';
  const rotateModeActive = toolMode === 'rotateStage';

  return (
    <HandleTarget>
      <group
        ref={groupRef}
        position={position}
        rotation={rotation}
        pointerEventsType={{ deny: 'grab' }}
      >
        {/* Drag Handle Bar - grab to reposition the panel */}
        <Handle
          handleRef={handleRef}
          targetRef={groupRef}
          scale={false}
          multitouch={false}
          rotate={false}
        >
          <mesh
            ref={handleRef}
            position={[0, -0.4, 0.01]}
            onPointerEnter={() => {
              const mat = handleRef.current?.material as MeshStandardMaterial | undefined;
              if (mat) {
                mat.color.copy(HANDLE_COLOR_HOVER);
                mat.opacity = 0.9;
              }
            }}
            onPointerLeave={() => {
              const mat = handleRef.current?.material as MeshStandardMaterial | undefined;
              if (mat) {
                mat.color.copy(HANDLE_COLOR_DEFAULT);
                mat.opacity = 0.6;
              }
            }}
          >
            <boxGeometry args={[1.0, 0.05, 0.02]} />
            <meshStandardMaterial color="#666666" transparent opacity={0.6} roughness={0.5} />
          </mesh>
        </Handle>

        <Container
          pixelSize={0.001}
          width={1920}
          height={1584}
          alignItems="center"
          justifyContent="center"
          pointerEvents="auto"
          padding={40}
          sizeX={3}
          sizeY={2.475}
        >
          <Container
            width={1900}
            height={1040}
            backgroundColor="rgba(40, 40, 40, 0.85)"
            borderRadius={20}
            padding={50}
            paddingLeft={50}
            paddingRight={50}
            alignItems="center"
            justifyContent="center"
            flexDirection="row"
            gap={36}
          >
            {/* Left Column - Performance Metrics */}
            <Container
              width={520}
              flexDirection="column"
              gap={24}
              alignItems="center"
              justifyContent="center"
            >
              <Container
                width="100%"
                flexDirection="column"
                gap={20}
                alignItems="center"
                justifyContent="center"
                backgroundColor="rgba(20, 20, 20, 0.6)"
                borderRadius={20}
                padding={36}
              >
                <Text
                  fontSize={52}
                  fontWeight="bold"
                  color="white"
                  textAlign="center"
                  marginBottom={4}
                >
                  Performance
                </Text>

                <Container
                  width={METRIC_SLOT_WIDTH}
                  height={METRIC_SLOT_HEIGHT}
                  alignItems="center"
                  justifyContent="center"
                >
                  <PerformanceCanvasImage
                    width={METRIC_SLOT_WIDTH}
                    height={METRIC_SLOT_HEIGHT}
                    renderFpsText={renderFpsText}
                    streamingFpsText={streamingFpsText}
                    poseToRenderText={poseToRenderText}
                  />
                </Container>
              </Container>
            </Container>

            {/* Right Column - Controls */}
            <Container
              flexGrow={1}
              flexDirection="column"
              gap={18}
              alignItems="center"
              justifyContent="center"
            >
              <Text fontSize={92} fontWeight="bold" color="white" textAlign="center">
                Controls
              </Text>

              <Text fontSize={42} color="white" textAlign="center" marginBottom={4}>
                Tool: {getToolModeLabel(toolMode)}
              </Text>

              <Text fontSize={38} color="white" textAlign="center" marginBottom={4}>
                Server address: {serverAddress}
              </Text>

              <Text fontSize={38} color="white" textAlign="center" marginBottom={24}>
                Session status: {sessionStatus}
              </Text>

              <Text fontSize={32} color="rgba(255,255,255,0.85)" textAlign="center" marginBottom={18}>
                Select a mode, then hold the right trigger to manipulate the stage.
              </Text>

              <Container
                flexDirection="column"
                gap={36}
                alignItems="center"
                justifyContent="center"
                width="100%"
              >
                {/* Mode Buttons */}
                <Container flexDirection="row" gap={36} justifyContent="center">
                  <Button
                    {...xrButton('moveMode', onMoveMode)}
                    variant="default"
                    width={340}
                    height={112}
                    borderRadius={36}
                    backgroundColor={
                      moveModeActive
                        ? 'rgba(100, 150, 255, 1)'
                        : 'rgba(220, 220, 220, 0.9)'
                    }
                    hover={{
                      backgroundColor: 'rgba(100, 150, 255, 1)',
                      borderColor: 'white',
                      borderWidth: 2,
                    }}
                  >
                    <Text fontSize={42} color="black" fontWeight="medium">
                      Move
                    </Text>
                  </Button>

                  <Button
                    {...xrButton('scaleMode', onScaleMode)}
                    variant="default"
                    width={340}
                    height={112}
                    borderRadius={36}
                    backgroundColor={
                      scaleModeActive
                        ? 'rgba(100, 255, 150, 1)'
                        : 'rgba(220, 220, 220, 0.9)'
                    }
                    hover={{
                      backgroundColor: 'rgba(100, 255, 150, 1)',
                      borderColor: 'white',
                      borderWidth: 2,
                    }}
                  >
                    <Text fontSize={42} color="black" fontWeight="medium">
                      Scale
                    </Text>
                  </Button>

                  <Button
                    {...xrButton('rotateMode', onRotateMode)}
                    variant="default"
                    width={340}
                    height={112}
                    borderRadius={36}
                    backgroundColor={
                      rotateModeActive
                        ? 'rgba(255, 180, 100, 1)'
                        : 'rgba(220, 220, 220, 0.9)'
                    }
                    hover={{
                      backgroundColor: 'rgba(255, 180, 100, 1)',
                      borderColor: 'white',
                      borderWidth: 2,
                    }}
                  >
                    <Text fontSize={42} color="black" fontWeight="medium">
                      Rotate
                    </Text>
                  </Button>
                </Container>

                {/* Timeline Buttons */}
                <Container flexDirection="row" gap={40} justifyContent="center">
                  <Button
                    {...xrButton('toggleTimeline', onToggleTimeline)}
                    variant="default"
                    width={330}
                    height={105}
                    borderRadius={35}
                    backgroundColor="rgba(150, 220, 255, 0.9)"
                    hover={{
                      backgroundColor: 'rgba(80, 190, 255, 1)',
                      borderColor: 'white',
                      borderWidth: 2,
                    }}
                  >
                    <Text fontSize={38} color="black" fontWeight="medium">
                      Play / Pause
                    </Text>
                  </Button>

                  <Button
                    {...xrButton('stopTimeline', onStopTimeline)}
                    variant="default"
                    width={330}
                    height={105}
                    borderRadius={35}
                    backgroundColor="rgba(220, 220, 220, 0.9)"
                    hover={{
                      backgroundColor: 'rgba(180, 180, 180, 1)',
                      borderColor: 'white',
                      borderWidth: 2,
                    }}
                  >
                    <Text fontSize={40} color="black" fontWeight="medium">
                      Stop
                    </Text>
                  </Button>
                </Container>

                {/* Bottom Row */}
                <Container flexDirection="row" gap={40} justifyContent="center">
                  <Button
                    {...xrButton('resetStage', onResetStage)}
                    variant="default"
                    width={330}
                    height={105}
                    borderRadius={35}
                    backgroundColor="rgba(255, 230, 150, 0.9)"
                    hover={{
                      backgroundColor: 'rgba(255, 210, 80, 1)',
                      borderColor: 'white',
                      borderWidth: 2,
                    }}
                  >
                    <Text fontSize={40} color="black" fontWeight="medium">
                      Reset Stage
                    </Text>
                  </Button>

                  <Button
                    {...xrButton('disconnect', onDisconnect)}
                    variant="destructive"
                    width={330}
                    height={105}
                    borderRadius={35}
                    backgroundColor="rgba(255, 150, 150, 0.9)"
                    hover={{
                      backgroundColor: 'rgba(255, 50, 50, 1)',
                      borderColor: 'white',
                      borderWidth: 2,
                    }}
                  >
                    <Container flexDirection="row" alignItems="center" gap={12}>
                      <Image src="./arrow-left-start-on-rectangle.svg" width={60} height={60} />
                      <Text fontSize={40} color="black" fontWeight="medium">
                        Disconnect
                      </Text>
                    </Container>
                  </Button>
                </Container>
              </Container>
            </Container>
          </Container>
        </Container>
      </group>
    </HandleTarget>
  );
}