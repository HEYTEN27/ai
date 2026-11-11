// Дополнения Three.js r147 (examples/js, MIT): управление камерой, экспорт и загрузка STL/OBJ/GLB.
// Собраны в один файл для 3D-артефактов (этап 15б). Лицензия — LICENSE-three.txt.

// ---- controls/OrbitControls.js ----
( function () {

	// This set of controls performs orbiting, dollying (zooming), and panning.
	// Unlike TrackballControls, it maintains the "up" direction object.up (+Y by default).
	//
	//    Orbit - left mouse / touch: one-finger move
	//    Zoom - middle mouse, or mousewheel / touch: two-finger spread or squish
	//    Pan - right mouse, or left mouse + ctrl/meta/shiftKey, or arrow keys / touch: two-finger move

	const _changeEvent = {
		type: 'change'
	};
	const _startEvent = {
		type: 'start'
	};
	const _endEvent = {
		type: 'end'
	};
	class OrbitControls extends THREE.EventDispatcher {

		constructor( object, domElement ) {

			super();
			this.object = object;
			this.domElement = domElement;
			this.domElement.style.touchAction = 'none'; // disable touch scroll

			// Set to false to disable this control
			this.enabled = true;

			// "target" sets the location of focus, where the object orbits around
			this.target = new THREE.Vector3();

			// How far you can dolly in and out ( PerspectiveCamera only )
			this.minDistance = 0;
			this.maxDistance = Infinity;

			// How far you can zoom in and out ( OrthographicCamera only )
			this.minZoom = 0;
			this.maxZoom = Infinity;

			// How far you can orbit vertically, upper and lower limits.
			// Range is 0 to Math.PI radians.
			this.minPolarAngle = 0; // radians
			this.maxPolarAngle = Math.PI; // radians

			// How far you can orbit horizontally, upper and lower limits.
			// If set, the interval [ min, max ] must be a sub-interval of [ - 2 PI, 2 PI ], with ( max - min < 2 PI )
			this.minAzimuthAngle = - Infinity; // radians
			this.maxAzimuthAngle = Infinity; // radians

			// Set to true to enable damping (inertia)
			// If damping is enabled, you must call controls.update() in your animation loop
			this.enableDamping = false;
			this.dampingFactor = 0.05;

			// This option actually enables dollying in and out; left as "zoom" for backwards compatibility.
			// Set to false to disable zooming
			this.enableZoom = true;
			this.zoomSpeed = 1.0;

			// Set to false to disable rotating
			this.enableRotate = true;
			this.rotateSpeed = 1.0;

			// Set to false to disable panning
			this.enablePan = true;
			this.panSpeed = 1.0;
			this.screenSpacePanning = true; // if false, pan orthogonal to world-space direction camera.up
			this.keyPanSpeed = 7.0; // pixels moved per arrow key push

			// Set to true to automatically rotate around the target
			// If auto-rotate is enabled, you must call controls.update() in your animation loop
			this.autoRotate = false;
			this.autoRotateSpeed = 2.0; // 30 seconds per orbit when fps is 60

			// The four arrow keys
			this.keys = {
				LEFT: 'ArrowLeft',
				UP: 'ArrowUp',
				RIGHT: 'ArrowRight',
				BOTTOM: 'ArrowDown'
			};

			// Mouse buttons
			this.mouseButtons = {
				LEFT: THREE.MOUSE.ROTATE,
				MIDDLE: THREE.MOUSE.DOLLY,
				RIGHT: THREE.MOUSE.PAN
			};

			// Touch fingers
			this.touches = {
				ONE: THREE.TOUCH.ROTATE,
				TWO: THREE.TOUCH.DOLLY_PAN
			};

			// for reset
			this.target0 = this.target.clone();
			this.position0 = this.object.position.clone();
			this.zoom0 = this.object.zoom;

			// the target DOM element for key events
			this._domElementKeyEvents = null;

			//
			// public methods
			//

			this.getPolarAngle = function () {

				return spherical.phi;

			};

			this.getAzimuthalAngle = function () {

				return spherical.theta;

			};

			this.getDistance = function () {

				return this.object.position.distanceTo( this.target );

			};

			this.listenToKeyEvents = function ( domElement ) {

				domElement.addEventListener( 'keydown', onKeyDown );
				this._domElementKeyEvents = domElement;

			};

			this.saveState = function () {

				scope.target0.copy( scope.target );
				scope.position0.copy( scope.object.position );
				scope.zoom0 = scope.object.zoom;

			};

			this.reset = function () {

				scope.target.copy( scope.target0 );
				scope.object.position.copy( scope.position0 );
				scope.object.zoom = scope.zoom0;
				scope.object.updateProjectionMatrix();
				scope.dispatchEvent( _changeEvent );
				scope.update();
				state = STATE.NONE;

			};

			// this method is exposed, but perhaps it would be better if we can make it private...
			this.update = function () {

				const offset = new THREE.Vector3();

				// so camera.up is the orbit axis
				const quat = new THREE.Quaternion().setFromUnitVectors( object.up, new THREE.Vector3( 0, 1, 0 ) );
				const quatInverse = quat.clone().invert();
				const lastPosition = new THREE.Vector3();
				const lastQuaternion = new THREE.Quaternion();
				const twoPI = 2 * Math.PI;
				return function update() {

					const position = scope.object.position;
					offset.copy( position ).sub( scope.target );

					// rotate offset to "y-axis-is-up" space
					offset.applyQuaternion( quat );

					// angle from z-axis around y-axis
					spherical.setFromVector3( offset );
					if ( scope.autoRotate && state === STATE.NONE ) {

						rotateLeft( getAutoRotationAngle() );

					}

					if ( scope.enableDamping ) {

						spherical.theta += sphericalDelta.theta * scope.dampingFactor;
						spherical.phi += sphericalDelta.phi * scope.dampingFactor;

					} else {

						spherical.theta += sphericalDelta.theta;
						spherical.phi += sphericalDelta.phi;

					}

					// restrict theta to be between desired limits

					let min = scope.minAzimuthAngle;
					let max = scope.maxAzimuthAngle;
					if ( isFinite( min ) && isFinite( max ) ) {

						if ( min < - Math.PI ) min += twoPI; else if ( min > Math.PI ) min -= twoPI;
						if ( max < - Math.PI ) max += twoPI; else if ( max > Math.PI ) max -= twoPI;
						if ( min <= max ) {

							spherical.theta = Math.max( min, Math.min( max, spherical.theta ) );

						} else {

							spherical.theta = spherical.theta > ( min + max ) / 2 ? Math.max( min, spherical.theta ) : Math.min( max, spherical.theta );

						}

					}

					// restrict phi to be between desired limits
					spherical.phi = Math.max( scope.minPolarAngle, Math.min( scope.maxPolarAngle, spherical.phi ) );
					spherical.makeSafe();
					spherical.radius *= scale;

					// restrict radius to be between desired limits
					spherical.radius = Math.max( scope.minDistance, Math.min( scope.maxDistance, spherical.radius ) );

					// move target to panned location

					if ( scope.enableDamping === true ) {

						scope.target.addScaledVector( panOffset, scope.dampingFactor );

					} else {

						scope.target.add( panOffset );

					}

					offset.setFromSpherical( spherical );

					// rotate offset back to "camera-up-vector-is-up" space
					offset.applyQuaternion( quatInverse );
					position.copy( scope.target ).add( offset );
					scope.object.lookAt( scope.target );
					if ( scope.enableDamping === true ) {

						sphericalDelta.theta *= 1 - scope.dampingFactor;
						sphericalDelta.phi *= 1 - scope.dampingFactor;
						panOffset.multiplyScalar( 1 - scope.dampingFactor );

					} else {

						sphericalDelta.set( 0, 0, 0 );
						panOffset.set( 0, 0, 0 );

					}

					scale = 1;

					// update condition is:
					// min(camera displacement, camera rotation in radians)^2 > EPS
					// using small-angle approximation cos(x/2) = 1 - x^2 / 8

					if ( zoomChanged || lastPosition.distanceToSquared( scope.object.position ) > EPS || 8 * ( 1 - lastQuaternion.dot( scope.object.quaternion ) ) > EPS ) {

						scope.dispatchEvent( _changeEvent );
						lastPosition.copy( scope.object.position );
						lastQuaternion.copy( scope.object.quaternion );
						zoomChanged = false;
						return true;

					}

					return false;

				};

			}();
			this.dispose = function () {

				scope.domElement.removeEventListener( 'contextmenu', onContextMenu );
				scope.domElement.removeEventListener( 'pointerdown', onPointerDown );
				scope.domElement.removeEventListener( 'pointercancel', onPointerCancel );
				scope.domElement.removeEventListener( 'wheel', onMouseWheel );
				scope.domElement.removeEventListener( 'pointermove', onPointerMove );
				scope.domElement.removeEventListener( 'pointerup', onPointerUp );
				if ( scope._domElementKeyEvents !== null ) {

					scope._domElementKeyEvents.removeEventListener( 'keydown', onKeyDown );

				}

				//scope.dispatchEvent( { type: 'dispose' } ); // should this be added here?

			};

			//
			// internals
			//

			const scope = this;
			const STATE = {
				NONE: - 1,
				ROTATE: 0,
				DOLLY: 1,
				PAN: 2,
				TOUCH_ROTATE: 3,
				TOUCH_PAN: 4,
				TOUCH_DOLLY_PAN: 5,
				TOUCH_DOLLY_ROTATE: 6
			};
			let state = STATE.NONE;
			const EPS = 0.000001;

			// current position in spherical coordinates
			const spherical = new THREE.Spherical();
			const sphericalDelta = new THREE.Spherical();
			let scale = 1;
			const panOffset = new THREE.Vector3();
			let zoomChanged = false;
			const rotateStart = new THREE.Vector2();
			const rotateEnd = new THREE.Vector2();
			const rotateDelta = new THREE.Vector2();
			const panStart = new THREE.Vector2();
			const panEnd = new THREE.Vector2();
			const panDelta = new THREE.Vector2();
			const dollyStart = new THREE.Vector2();
			const dollyEnd = new THREE.Vector2();
			const dollyDelta = new THREE.Vector2();
			const pointers = [];
			const pointerPositions = {};
			function getAutoRotationAngle() {

				return 2 * Math.PI / 60 / 60 * scope.autoRotateSpeed;

			}

			function getZoomScale() {

				return Math.pow( 0.95, scope.zoomSpeed );

			}

			function rotateLeft( angle ) {

				sphericalDelta.theta -= angle;

			}

			function rotateUp( angle ) {

				sphericalDelta.phi -= angle;

			}

			const panLeft = function () {

				const v = new THREE.Vector3();
				return function panLeft( distance, objectMatrix ) {

					v.setFromMatrixColumn( objectMatrix, 0 ); // get X column of objectMatrix
					v.multiplyScalar( - distance );
					panOffset.add( v );

				};

			}();
			const panUp = function () {

				const v = new THREE.Vector3();
				return function panUp( distance, objectMatrix ) {

					if ( scope.screenSpacePanning === true ) {

						v.setFromMatrixColumn( objectMatrix, 1 );

					} else {

						v.setFromMatrixColumn( objectMatrix, 0 );
						v.crossVectors( scope.object.up, v );

					}

					v.multiplyScalar( distance );
					panOffset.add( v );

				};

			}();

			// deltaX and deltaY are in pixels; right and down are positive
			const pan = function () {

				const offset = new THREE.Vector3();
				return function pan( deltaX, deltaY ) {

					const element = scope.domElement;
					if ( scope.object.isPerspectiveCamera ) {

						// perspective
						const position = scope.object.position;
						offset.copy( position ).sub( scope.target );
						let targetDistance = offset.length();

						// half of the fov is center to top of screen
						targetDistance *= Math.tan( scope.object.fov / 2 * Math.PI / 180.0 );

						// we use only clientHeight here so aspect ratio does not distort speed
						panLeft( 2 * deltaX * targetDistance / element.clientHeight, scope.object.matrix );
						panUp( 2 * deltaY * targetDistance / element.clientHeight, scope.object.matrix );

					} else if ( scope.object.isOrthographicCamera ) {

						// orthographic
						panLeft( deltaX * ( scope.object.right - scope.object.left ) / scope.object.zoom / element.clientWidth, scope.object.matrix );
						panUp( deltaY * ( scope.object.top - scope.object.bottom ) / scope.object.zoom / element.clientHeight, scope.object.matrix );

					} else {

						// camera neither orthographic nor perspective
						console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - pan disabled.' );
						scope.enablePan = false;

					}

				};

			}();
			function dollyOut( dollyScale ) {

				if ( scope.object.isPerspectiveCamera ) {

					scale /= dollyScale;

				} else if ( scope.object.isOrthographicCamera ) {

					scope.object.zoom = Math.max( scope.minZoom, Math.min( scope.maxZoom, scope.object.zoom * dollyScale ) );
					scope.object.updateProjectionMatrix();
					zoomChanged = true;

				} else {

					console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled.' );
					scope.enableZoom = false;

				}

			}

			function dollyIn( dollyScale ) {

				if ( scope.object.isPerspectiveCamera ) {

					scale *= dollyScale;

				} else if ( scope.object.isOrthographicCamera ) {

					scope.object.zoom = Math.max( scope.minZoom, Math.min( scope.maxZoom, scope.object.zoom / dollyScale ) );
					scope.object.updateProjectionMatrix();
					zoomChanged = true;

				} else {

					console.warn( 'WARNING: OrbitControls.js encountered an unknown camera type - dolly/zoom disabled.' );
					scope.enableZoom = false;

				}

			}

			//
			// event callbacks - update the object state
			//

			function handleMouseDownRotate( event ) {

				rotateStart.set( event.clientX, event.clientY );

			}

			function handleMouseDownDolly( event ) {

				dollyStart.set( event.clientX, event.clientY );

			}

			function handleMouseDownPan( event ) {

				panStart.set( event.clientX, event.clientY );

			}

			function handleMouseMoveRotate( event ) {

				rotateEnd.set( event.clientX, event.clientY );
				rotateDelta.subVectors( rotateEnd, rotateStart ).multiplyScalar( scope.rotateSpeed );
				const element = scope.domElement;
				rotateLeft( 2 * Math.PI * rotateDelta.x / element.clientHeight ); // yes, height

				rotateUp( 2 * Math.PI * rotateDelta.y / element.clientHeight );
				rotateStart.copy( rotateEnd );
				scope.update();

			}

			function handleMouseMoveDolly( event ) {

				dollyEnd.set( event.clientX, event.clientY );
				dollyDelta.subVectors( dollyEnd, dollyStart );
				if ( dollyDelta.y > 0 ) {

					dollyOut( getZoomScale() );

				} else if ( dollyDelta.y < 0 ) {

					dollyIn( getZoomScale() );

				}

				dollyStart.copy( dollyEnd );
				scope.update();

			}

			function handleMouseMovePan( event ) {

				panEnd.set( event.clientX, event.clientY );
				panDelta.subVectors( panEnd, panStart ).multiplyScalar( scope.panSpeed );
				pan( panDelta.x, panDelta.y );
				panStart.copy( panEnd );
				scope.update();

			}

			function handleMouseWheel( event ) {

				if ( event.deltaY < 0 ) {

					dollyIn( getZoomScale() );

				} else if ( event.deltaY > 0 ) {

					dollyOut( getZoomScale() );

				}

				scope.update();

			}

			function handleKeyDown( event ) {

				let needsUpdate = false;
				switch ( event.code ) {

					case scope.keys.UP:
						if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

							rotateUp( 2 * Math.PI * scope.rotateSpeed / scope.domElement.clientHeight );

						} else {

							pan( 0, scope.keyPanSpeed );

						}

						needsUpdate = true;
						break;
					case scope.keys.BOTTOM:
						if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

							rotateUp( - 2 * Math.PI * scope.rotateSpeed / scope.domElement.clientHeight );

						} else {

							pan( 0, - scope.keyPanSpeed );

						}

						needsUpdate = true;
						break;
					case scope.keys.LEFT:
						if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

							rotateLeft( 2 * Math.PI * scope.rotateSpeed / scope.domElement.clientHeight );

						} else {

							pan( scope.keyPanSpeed, 0 );

						}

						needsUpdate = true;
						break;
					case scope.keys.RIGHT:
						if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

							rotateLeft( - 2 * Math.PI * scope.rotateSpeed / scope.domElement.clientHeight );

						} else {

							pan( - scope.keyPanSpeed, 0 );

						}

						needsUpdate = true;
						break;

				}

				if ( needsUpdate ) {

					// prevent the browser from scrolling on cursor keys
					event.preventDefault();
					scope.update();

				}

			}

			function handleTouchStartRotate() {

				if ( pointers.length === 1 ) {

					rotateStart.set( pointers[ 0 ].pageX, pointers[ 0 ].pageY );

				} else {

					const x = 0.5 * ( pointers[ 0 ].pageX + pointers[ 1 ].pageX );
					const y = 0.5 * ( pointers[ 0 ].pageY + pointers[ 1 ].pageY );
					rotateStart.set( x, y );

				}

			}

			function handleTouchStartPan() {

				if ( pointers.length === 1 ) {

					panStart.set( pointers[ 0 ].pageX, pointers[ 0 ].pageY );

				} else {

					const x = 0.5 * ( pointers[ 0 ].pageX + pointers[ 1 ].pageX );
					const y = 0.5 * ( pointers[ 0 ].pageY + pointers[ 1 ].pageY );
					panStart.set( x, y );

				}

			}

			function handleTouchStartDolly() {

				const dx = pointers[ 0 ].pageX - pointers[ 1 ].pageX;
				const dy = pointers[ 0 ].pageY - pointers[ 1 ].pageY;
				const distance = Math.sqrt( dx * dx + dy * dy );
				dollyStart.set( 0, distance );

			}

			function handleTouchStartDollyPan() {

				if ( scope.enableZoom ) handleTouchStartDolly();
				if ( scope.enablePan ) handleTouchStartPan();

			}

			function handleTouchStartDollyRotate() {

				if ( scope.enableZoom ) handleTouchStartDolly();
				if ( scope.enableRotate ) handleTouchStartRotate();

			}

			function handleTouchMoveRotate( event ) {

				if ( pointers.length == 1 ) {

					rotateEnd.set( event.pageX, event.pageY );

				} else {

					const position = getSecondPointerPosition( event );
					const x = 0.5 * ( event.pageX + position.x );
					const y = 0.5 * ( event.pageY + position.y );
					rotateEnd.set( x, y );

				}

				rotateDelta.subVectors( rotateEnd, rotateStart ).multiplyScalar( scope.rotateSpeed );
				const element = scope.domElement;
				rotateLeft( 2 * Math.PI * rotateDelta.x / element.clientHeight ); // yes, height

				rotateUp( 2 * Math.PI * rotateDelta.y / element.clientHeight );
				rotateStart.copy( rotateEnd );

			}

			function handleTouchMovePan( event ) {

				if ( pointers.length === 1 ) {

					panEnd.set( event.pageX, event.pageY );

				} else {

					const position = getSecondPointerPosition( event );
					const x = 0.5 * ( event.pageX + position.x );
					const y = 0.5 * ( event.pageY + position.y );
					panEnd.set( x, y );

				}

				panDelta.subVectors( panEnd, panStart ).multiplyScalar( scope.panSpeed );
				pan( panDelta.x, panDelta.y );
				panStart.copy( panEnd );

			}

			function handleTouchMoveDolly( event ) {

				const position = getSecondPointerPosition( event );
				const dx = event.pageX - position.x;
				const dy = event.pageY - position.y;
				const distance = Math.sqrt( dx * dx + dy * dy );
				dollyEnd.set( 0, distance );
				dollyDelta.set( 0, Math.pow( dollyEnd.y / dollyStart.y, scope.zoomSpeed ) );
				dollyOut( dollyDelta.y );
				dollyStart.copy( dollyEnd );

			}

			function handleTouchMoveDollyPan( event ) {

				if ( scope.enableZoom ) handleTouchMoveDolly( event );
				if ( scope.enablePan ) handleTouchMovePan( event );

			}

			function handleTouchMoveDollyRotate( event ) {

				if ( scope.enableZoom ) handleTouchMoveDolly( event );
				if ( scope.enableRotate ) handleTouchMoveRotate( event );

			}

			//
			// event handlers - FSM: listen for events and reset state
			//

			function onPointerDown( event ) {

				if ( scope.enabled === false ) return;
				if ( pointers.length === 0 ) {

					scope.domElement.setPointerCapture( event.pointerId );
					scope.domElement.addEventListener( 'pointermove', onPointerMove );
					scope.domElement.addEventListener( 'pointerup', onPointerUp );

				}

				//

				addPointer( event );
				if ( event.pointerType === 'touch' ) {

					onTouchStart( event );

				} else {

					onMouseDown( event );

				}

			}

			function onPointerMove( event ) {

				if ( scope.enabled === false ) return;
				if ( event.pointerType === 'touch' ) {

					onTouchMove( event );

				} else {

					onMouseMove( event );

				}

			}

			function onPointerUp( event ) {

				removePointer( event );
				if ( pointers.length === 0 ) {

					scope.domElement.releasePointerCapture( event.pointerId );
					scope.domElement.removeEventListener( 'pointermove', onPointerMove );
					scope.domElement.removeEventListener( 'pointerup', onPointerUp );

				}

				scope.dispatchEvent( _endEvent );
				state = STATE.NONE;

			}

			function onPointerCancel( event ) {

				removePointer( event );

			}

			function onMouseDown( event ) {

				let mouseAction;
				switch ( event.button ) {

					case 0:
						mouseAction = scope.mouseButtons.LEFT;
						break;
					case 1:
						mouseAction = scope.mouseButtons.MIDDLE;
						break;
					case 2:
						mouseAction = scope.mouseButtons.RIGHT;
						break;
					default:
						mouseAction = - 1;

				}

				switch ( mouseAction ) {

					case THREE.MOUSE.DOLLY:
						if ( scope.enableZoom === false ) return;
						handleMouseDownDolly( event );
						state = STATE.DOLLY;
						break;
					case THREE.MOUSE.ROTATE:
						if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

							if ( scope.enablePan === false ) return;
							handleMouseDownPan( event );
							state = STATE.PAN;

						} else {

							if ( scope.enableRotate === false ) return;
							handleMouseDownRotate( event );
							state = STATE.ROTATE;

						}

						break;
					case THREE.MOUSE.PAN:
						if ( event.ctrlKey || event.metaKey || event.shiftKey ) {

							if ( scope.enableRotate === false ) return;
							handleMouseDownRotate( event );
							state = STATE.ROTATE;

						} else {

							if ( scope.enablePan === false ) return;
							handleMouseDownPan( event );
							state = STATE.PAN;

						}

						break;
					default:
						state = STATE.NONE;

				}

				if ( state !== STATE.NONE ) {

					scope.dispatchEvent( _startEvent );

				}

			}

			function onMouseMove( event ) {

				switch ( state ) {

					case STATE.ROTATE:
						if ( scope.enableRotate === false ) return;
						handleMouseMoveRotate( event );
						break;
					case STATE.DOLLY:
						if ( scope.enableZoom === false ) return;
						handleMouseMoveDolly( event );
						break;
					case STATE.PAN:
						if ( scope.enablePan === false ) return;
						handleMouseMovePan( event );
						break;

				}

			}

			function onMouseWheel( event ) {

				if ( scope.enabled === false || scope.enableZoom === false || state !== STATE.NONE ) return;
				event.preventDefault();
				scope.dispatchEvent( _startEvent );
				handleMouseWheel( event );
				scope.dispatchEvent( _endEvent );

			}

			function onKeyDown( event ) {

				if ( scope.enabled === false || scope.enablePan === false ) return;
				handleKeyDown( event );

			}

			function onTouchStart( event ) {

				trackPointer( event );
				switch ( pointers.length ) {

					case 1:
						switch ( scope.touches.ONE ) {

							case THREE.TOUCH.ROTATE:
								if ( scope.enableRotate === false ) return;
								handleTouchStartRotate();
								state = STATE.TOUCH_ROTATE;
								break;
							case THREE.TOUCH.PAN:
								if ( scope.enablePan === false ) return;
								handleTouchStartPan();
								state = STATE.TOUCH_PAN;
								break;
							default:
								state = STATE.NONE;

						}

						break;
					case 2:
						switch ( scope.touches.TWO ) {

							case THREE.TOUCH.DOLLY_PAN:
								if ( scope.enableZoom === false && scope.enablePan === false ) return;
								handleTouchStartDollyPan();
								state = STATE.TOUCH_DOLLY_PAN;
								break;
							case THREE.TOUCH.DOLLY_ROTATE:
								if ( scope.enableZoom === false && scope.enableRotate === false ) return;
								handleTouchStartDollyRotate();
								state = STATE.TOUCH_DOLLY_ROTATE;
								break;
							default:
								state = STATE.NONE;

						}

						break;
					default:
						state = STATE.NONE;

				}

				if ( state !== STATE.NONE ) {

					scope.dispatchEvent( _startEvent );

				}

			}

			function onTouchMove( event ) {

				trackPointer( event );
				switch ( state ) {

					case STATE.TOUCH_ROTATE:
						if ( scope.enableRotate === false ) return;
						handleTouchMoveRotate( event );
						scope.update();
						break;
					case STATE.TOUCH_PAN:
						if ( scope.enablePan === false ) return;
						handleTouchMovePan( event );
						scope.update();
						break;
					case STATE.TOUCH_DOLLY_PAN:
						if ( scope.enableZoom === false && scope.enablePan === false ) return;
						handleTouchMoveDollyPan( event );
						scope.update();
						break;
					case STATE.TOUCH_DOLLY_ROTATE:
						if ( scope.enableZoom === false && scope.enableRotate === false ) return;
						handleTouchMoveDollyRotate( event );
						scope.update();
						break;
					default:
						state = STATE.NONE;

				}

			}

			function onContextMenu( event ) {

				if ( scope.enabled === false ) return;
				event.preventDefault();

			}

			function addPointer( event ) {

				pointers.push( event );

			}

			function removePointer( event ) {

				delete pointerPositions[ event.pointerId ];
				for ( let i = 0; i < pointers.length; i ++ ) {

					if ( pointers[ i ].pointerId == event.pointerId ) {

						pointers.splice( i, 1 );
						return;

					}

				}

			}

			function trackPointer( event ) {

				let position = pointerPositions[ event.pointerId ];
				if ( position === undefined ) {

					position = new THREE.Vector2();
					pointerPositions[ event.pointerId ] = position;

				}

				position.set( event.pageX, event.pageY );

			}

			function getSecondPointerPosition( event ) {

				const pointer = event.pointerId === pointers[ 0 ].pointerId ? pointers[ 1 ] : pointers[ 0 ];
				return pointerPositions[ pointer.pointerId ];

			}

			//

			scope.domElement.addEventListener( 'contextmenu', onContextMenu );
			scope.domElement.addEventListener( 'pointerdown', onPointerDown );
			scope.domElement.addEventListener( 'pointercancel', onPointerCancel );
			scope.domElement.addEventListener( 'wheel', onMouseWheel, {
				passive: false
			} );

			// force an update at start

			this.update();

		}

	}

	// This set of controls performs orbiting, dollying (zooming), and panning.
	// Unlike TrackballControls, it maintains the "up" direction object.up (+Y by default).
	// This is very similar to OrbitControls, another set of touch behavior
	//
	//    Orbit - right mouse, or left mouse + ctrl/meta/shiftKey / touch: two-finger rotate
	//    Zoom - middle mouse, or mousewheel / touch: two-finger spread or squish
	//    Pan - left mouse, or arrow keys / touch: one-finger move

	class MapControls extends OrbitControls {

		constructor( object, domElement ) {

			super( object, domElement );
			this.screenSpacePanning = false; // pan orthogonal to world-space direction camera.up

			this.mouseButtons.LEFT = THREE.MOUSE.PAN;
			this.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
			this.touches.ONE = THREE.TOUCH.PAN;
			this.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;

		}

	}

	THREE.MapControls = MapControls;
	THREE.OrbitControls = OrbitControls;

} )();

// ---- exporters/STLExporter.js ----
( function () {

	/**
 * Usage:
 *  const exporter = new STLExporter();
 *
 *  // second argument is a list of options
 *  const data = exporter.parse( mesh, { binary: true } );
 *
 */

	class STLExporter {

		parse( scene, options = {} ) {

			const binary = options.binary !== undefined ? options.binary : false;

			//

			const objects = [];
			let triangles = 0;
			scene.traverse( function ( object ) {

				if ( object.isMesh ) {

					const geometry = object.geometry;
					const index = geometry.index;
					const positionAttribute = geometry.getAttribute( 'position' );
					triangles += index !== null ? index.count / 3 : positionAttribute.count / 3;
					objects.push( {
						object3d: object,
						geometry: geometry
					} );

				}

			} );
			let output;
			let offset = 80; // skip header

			if ( binary === true ) {

				const bufferLength = triangles * 2 + triangles * 3 * 4 * 4 + 80 + 4;
				const arrayBuffer = new ArrayBuffer( bufferLength );
				output = new DataView( arrayBuffer );
				output.setUint32( offset, triangles, true );
				offset += 4;

			} else {

				output = '';
				output += 'solid exported\n';

			}

			const vA = new THREE.Vector3();
			const vB = new THREE.Vector3();
			const vC = new THREE.Vector3();
			const cb = new THREE.Vector3();
			const ab = new THREE.Vector3();
			const normal = new THREE.Vector3();
			for ( let i = 0, il = objects.length; i < il; i ++ ) {

				const object = objects[ i ].object3d;
				const geometry = objects[ i ].geometry;
				const index = geometry.index;
				const positionAttribute = geometry.getAttribute( 'position' );
				if ( index !== null ) {

					// indexed geometry

					for ( let j = 0; j < index.count; j += 3 ) {

						const a = index.getX( j + 0 );
						const b = index.getX( j + 1 );
						const c = index.getX( j + 2 );
						writeFace( a, b, c, positionAttribute, object );

					}

				} else {

					// non-indexed geometry

					for ( let j = 0; j < positionAttribute.count; j += 3 ) {

						const a = j + 0;
						const b = j + 1;
						const c = j + 2;
						writeFace( a, b, c, positionAttribute, object );

					}

				}

			}

			if ( binary === false ) {

				output += 'endsolid exported\n';

			}

			return output;
			function writeFace( a, b, c, positionAttribute, object ) {

				vA.fromBufferAttribute( positionAttribute, a );
				vB.fromBufferAttribute( positionAttribute, b );
				vC.fromBufferAttribute( positionAttribute, c );
				if ( object.isSkinnedMesh === true ) {

					object.boneTransform( a, vA );
					object.boneTransform( b, vB );
					object.boneTransform( c, vC );

				}

				vA.applyMatrix4( object.matrixWorld );
				vB.applyMatrix4( object.matrixWorld );
				vC.applyMatrix4( object.matrixWorld );
				writeNormal( vA, vB, vC );
				writeVertex( vA );
				writeVertex( vB );
				writeVertex( vC );
				if ( binary === true ) {

					output.setUint16( offset, 0, true );
					offset += 2;

				} else {

					output += '\t\tendloop\n';
					output += '\tendfacet\n';

				}

			}

			function writeNormal( vA, vB, vC ) {

				cb.subVectors( vC, vB );
				ab.subVectors( vA, vB );
				cb.cross( ab ).normalize();
				normal.copy( cb ).normalize();
				if ( binary === true ) {

					output.setFloat32( offset, normal.x, true );
					offset += 4;
					output.setFloat32( offset, normal.y, true );
					offset += 4;
					output.setFloat32( offset, normal.z, true );
					offset += 4;

				} else {

					output += '\tfacet normal ' + normal.x + ' ' + normal.y + ' ' + normal.z + '\n';
					output += '\t\touter loop\n';

				}

			}

			function writeVertex( vertex ) {

				if ( binary === true ) {

					output.setFloat32( offset, vertex.x, true );
					offset += 4;
					output.setFloat32( offset, vertex.y, true );
					offset += 4;
					output.setFloat32( offset, vertex.z, true );
					offset += 4;

				} else {

					output += '\t\t\tvertex ' + vertex.x + ' ' + vertex.y + ' ' + vertex.z + '\n';

				}

			}

		}

	}

	THREE.STLExporter = STLExporter;

} )();

// ---- exporters/OBJExporter.js ----
( function () {

	class OBJExporter {

		parse( object ) {

			let output = '';
			let indexVertex = 0;
			let indexVertexUvs = 0;
			let indexNormals = 0;
			const vertex = new THREE.Vector3();
			const color = new THREE.Color();
			const normal = new THREE.Vector3();
			const uv = new THREE.Vector2();
			const face = [];
			function parseMesh( mesh ) {

				let nbVertex = 0;
				let nbNormals = 0;
				let nbVertexUvs = 0;
				const geometry = mesh.geometry;
				const normalMatrixWorld = new THREE.Matrix3();

				// shortcuts
				const vertices = geometry.getAttribute( 'position' );
				const normals = geometry.getAttribute( 'normal' );
				const uvs = geometry.getAttribute( 'uv' );
				const indices = geometry.getIndex();

				// name of the mesh object
				output += 'o ' + mesh.name + '\n';

				// name of the mesh material
				if ( mesh.material && mesh.material.name ) {

					output += 'usemtl ' + mesh.material.name + '\n';

				}

				// vertices

				if ( vertices !== undefined ) {

					for ( let i = 0, l = vertices.count; i < l; i ++, nbVertex ++ ) {

						vertex.fromBufferAttribute( vertices, i );

						// transform the vertex to world space
						vertex.applyMatrix4( mesh.matrixWorld );

						// transform the vertex to export format
						output += 'v ' + vertex.x + ' ' + vertex.y + ' ' + vertex.z + '\n';

					}

				}

				// uvs

				if ( uvs !== undefined ) {

					for ( let i = 0, l = uvs.count; i < l; i ++, nbVertexUvs ++ ) {

						uv.fromBufferAttribute( uvs, i );

						// transform the uv to export format
						output += 'vt ' + uv.x + ' ' + uv.y + '\n';

					}

				}

				// normals

				if ( normals !== undefined ) {

					normalMatrixWorld.getNormalMatrix( mesh.matrixWorld );
					for ( let i = 0, l = normals.count; i < l; i ++, nbNormals ++ ) {

						normal.fromBufferAttribute( normals, i );

						// transform the normal to world space
						normal.applyMatrix3( normalMatrixWorld ).normalize();

						// transform the normal to export format
						output += 'vn ' + normal.x + ' ' + normal.y + ' ' + normal.z + '\n';

					}

				}

				// faces

				if ( indices !== null ) {

					for ( let i = 0, l = indices.count; i < l; i += 3 ) {

						for ( let m = 0; m < 3; m ++ ) {

							const j = indices.getX( i + m ) + 1;
							face[ m ] = indexVertex + j + ( normals || uvs ? '/' + ( uvs ? indexVertexUvs + j : '' ) + ( normals ? '/' + ( indexNormals + j ) : '' ) : '' );

						}

						// transform the face to export format
						output += 'f ' + face.join( ' ' ) + '\n';

					}

				} else {

					for ( let i = 0, l = vertices.count; i < l; i += 3 ) {

						for ( let m = 0; m < 3; m ++ ) {

							const j = i + m + 1;
							face[ m ] = indexVertex + j + ( normals || uvs ? '/' + ( uvs ? indexVertexUvs + j : '' ) + ( normals ? '/' + ( indexNormals + j ) : '' ) : '' );

						}

						// transform the face to export format
						output += 'f ' + face.join( ' ' ) + '\n';

					}

				}

				// update index
				indexVertex += nbVertex;
				indexVertexUvs += nbVertexUvs;
				indexNormals += nbNormals;

			}

			function parseLine( line ) {

				let nbVertex = 0;
				const geometry = line.geometry;
				const type = line.type;

				// shortcuts
				const vertices = geometry.getAttribute( 'position' );

				// name of the line object
				output += 'o ' + line.name + '\n';
				if ( vertices !== undefined ) {

					for ( let i = 0, l = vertices.count; i < l; i ++, nbVertex ++ ) {

						vertex.fromBufferAttribute( vertices, i );

						// transform the vertex to world space
						vertex.applyMatrix4( line.matrixWorld );

						// transform the vertex to export format
						output += 'v ' + vertex.x + ' ' + vertex.y + ' ' + vertex.z + '\n';

					}

				}

				if ( type === 'Line' ) {

					output += 'l ';
					for ( let j = 1, l = vertices.count; j <= l; j ++ ) {

						output += indexVertex + j + ' ';

					}

					output += '\n';

				}

				if ( type === 'LineSegments' ) {

					for ( let j = 1, k = j + 1, l = vertices.count; j < l; j += 2, k = j + 1 ) {

						output += 'l ' + ( indexVertex + j ) + ' ' + ( indexVertex + k ) + '\n';

					}

				}

				// update index
				indexVertex += nbVertex;

			}

			function parsePoints( points ) {

				let nbVertex = 0;
				const geometry = points.geometry;
				const vertices = geometry.getAttribute( 'position' );
				const colors = geometry.getAttribute( 'color' );
				output += 'o ' + points.name + '\n';
				if ( vertices !== undefined ) {

					for ( let i = 0, l = vertices.count; i < l; i ++, nbVertex ++ ) {

						vertex.fromBufferAttribute( vertices, i );
						vertex.applyMatrix4( points.matrixWorld );
						output += 'v ' + vertex.x + ' ' + vertex.y + ' ' + vertex.z;
						if ( colors !== undefined ) {

							color.fromBufferAttribute( colors, i ).convertLinearToSRGB();
							output += ' ' + color.r + ' ' + color.g + ' ' + color.b;

						}

						output += '\n';

					}

					output += 'p ';
					for ( let j = 1, l = vertices.count; j <= l; j ++ ) {

						output += indexVertex + j + ' ';

					}

					output += '\n';

				}

				// update index
				indexVertex += nbVertex;

			}

			object.traverse( function ( child ) {

				if ( child.isMesh === true ) {

					parseMesh( child );

				}

				if ( child.isLine === true ) {

					parseLine( child );

				}

				if ( child.isPoints === true ) {

					parsePoints( child );

				}

			} );
			return output;

		}

	}

	THREE.OBJExporter = OBJExporter;

} )();

// ---- exporters/GLTFExporter.js ----
( function () {

	class GLTFExporter {

		constructor() {

			this.pluginCallbacks = [];
			this.register( function ( writer ) {

				return new GLTFLightExtension( writer );

			} );
			this.register( function ( writer ) {

				return new GLTFMaterialsUnlitExtension( writer );

			} );
			this.register( function ( writer ) {

				return new GLTFMaterialsTransmissionExtension( writer );

			} );
			this.register( function ( writer ) {

				return new GLTFMaterialsVolumeExtension( writer );

			} );
			this.register( function ( writer ) {

				return new GLTFMaterialsClearcoatExtension( writer );

			} );
			this.register( function ( writer ) {

				return new GLTFMaterialsIridescenceExtension( writer );

			} );

		}
		register( callback ) {

			if ( this.pluginCallbacks.indexOf( callback ) === - 1 ) {

				this.pluginCallbacks.push( callback );

			}

			return this;

		}
		unregister( callback ) {

			if ( this.pluginCallbacks.indexOf( callback ) !== - 1 ) {

				this.pluginCallbacks.splice( this.pluginCallbacks.indexOf( callback ), 1 );

			}

			return this;

		}

		/**
   * Parse scenes and generate GLTF output
   * @param  {Scene or [THREE.Scenes]} input   THREE.Scene or Array of THREE.Scenes
   * @param  {Function} onDone  Callback on completed
   * @param  {Function} onError  Callback on errors
   * @param  {Object} options options
   */
		parse( input, onDone, onError, options ) {

			const writer = new GLTFWriter();
			const plugins = [];
			for ( let i = 0, il = this.pluginCallbacks.length; i < il; i ++ ) {

				plugins.push( this.pluginCallbacks[ i ]( writer ) );

			}

			writer.setPlugins( plugins );
			writer.write( input, onDone, options ).catch( onError );

		}
		parseAsync( input, options ) {

			const scope = this;
			return new Promise( function ( resolve, reject ) {

				scope.parse( input, resolve, reject, options );

			} );

		}

	}

	//------------------------------------------------------------------------------
	// Constants
	//------------------------------------------------------------------------------

	const WEBGL_CONSTANTS = {
		POINTS: 0x0000,
		LINES: 0x0001,
		LINE_LOOP: 0x0002,
		LINE_STRIP: 0x0003,
		TRIANGLES: 0x0004,
		TRIANGLE_STRIP: 0x0005,
		TRIANGLE_FAN: 0x0006,
		UNSIGNED_BYTE: 0x1401,
		UNSIGNED_SHORT: 0x1403,
		FLOAT: 0x1406,
		UNSIGNED_INT: 0x1405,
		ARRAY_BUFFER: 0x8892,
		ELEMENT_ARRAY_BUFFER: 0x8893,
		NEAREST: 0x2600,
		LINEAR: 0x2601,
		NEAREST_MIPMAP_NEAREST: 0x2700,
		LINEAR_MIPMAP_NEAREST: 0x2701,
		NEAREST_MIPMAP_LINEAR: 0x2702,
		LINEAR_MIPMAP_LINEAR: 0x2703,
		CLAMP_TO_EDGE: 33071,
		MIRRORED_REPEAT: 33648,
		REPEAT: 10497
	};
	const THREE_TO_WEBGL = {};
	THREE_TO_WEBGL[ THREE.NearestFilter ] = WEBGL_CONSTANTS.NEAREST;
	THREE_TO_WEBGL[ THREE.NearestMipmapNearestFilter ] = WEBGL_CONSTANTS.NEAREST_MIPMAP_NEAREST;
	THREE_TO_WEBGL[ THREE.NearestMipmapLinearFilter ] = WEBGL_CONSTANTS.NEAREST_MIPMAP_LINEAR;
	THREE_TO_WEBGL[ THREE.LinearFilter ] = WEBGL_CONSTANTS.LINEAR;
	THREE_TO_WEBGL[ THREE.LinearMipmapNearestFilter ] = WEBGL_CONSTANTS.LINEAR_MIPMAP_NEAREST;
	THREE_TO_WEBGL[ THREE.LinearMipmapLinearFilter ] = WEBGL_CONSTANTS.LINEAR_MIPMAP_LINEAR;
	THREE_TO_WEBGL[ THREE.ClampToEdgeWrapping ] = WEBGL_CONSTANTS.CLAMP_TO_EDGE;
	THREE_TO_WEBGL[ THREE.RepeatWrapping ] = WEBGL_CONSTANTS.REPEAT;
	THREE_TO_WEBGL[ THREE.MirroredRepeatWrapping ] = WEBGL_CONSTANTS.MIRRORED_REPEAT;
	const PATH_PROPERTIES = {
		scale: 'scale',
		position: 'translation',
		quaternion: 'rotation',
		morphTargetInfluences: 'weights'
	};

	// GLB constants
	// https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#glb-file-format-specification

	const GLB_HEADER_BYTES = 12;
	const GLB_HEADER_MAGIC = 0x46546C67;
	const GLB_VERSION = 2;
	const GLB_CHUNK_PREFIX_BYTES = 8;
	const GLB_CHUNK_TYPE_JSON = 0x4E4F534A;
	const GLB_CHUNK_TYPE_BIN = 0x004E4942;

	//------------------------------------------------------------------------------
	// Utility functions
	//------------------------------------------------------------------------------

	/**
 * Compare two arrays
 * @param  {Array} array1 Array 1 to compare
 * @param  {Array} array2 Array 2 to compare
 * @return {Boolean}        Returns true if both arrays are equal
 */
	function equalArray( array1, array2 ) {

		return array1.length === array2.length && array1.every( function ( element, index ) {

			return element === array2[ index ];

		} );

	}

	/**
 * Converts a string to an ArrayBuffer.
 * @param  {string} text
 * @return {ArrayBuffer}
 */
	function stringToArrayBuffer( text ) {

		return new TextEncoder().encode( text ).buffer;

	}

	/**
 * Is identity matrix
 *
 * @param {Matrix4} matrix
 * @returns {Boolean} Returns true, if parameter is identity matrix
 */
	function isIdentityMatrix( matrix ) {

		return equalArray( matrix.elements, [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] );

	}

	/**
 * Get the min and max vectors from the given attribute
 * @param  {BufferAttribute} attribute Attribute to find the min/max in range from start to start + count
 * @param  {Integer} start
 * @param  {Integer} count
 * @return {Object} Object containing the `min` and `max` values (As an array of attribute.itemSize components)
 */
	function getMinMax( attribute, start, count ) {

		const output = {
			min: new Array( attribute.itemSize ).fill( Number.POSITIVE_INFINITY ),
			max: new Array( attribute.itemSize ).fill( Number.NEGATIVE_INFINITY )
		};
		for ( let i = start; i < start + count; i ++ ) {

			for ( let a = 0; a < attribute.itemSize; a ++ ) {

				let value;
				if ( attribute.itemSize > 4 ) {

					// no support for interleaved data for itemSize > 4

					value = attribute.array[ i * attribute.itemSize + a ];

				} else {

					if ( a === 0 ) value = attribute.getX( i ); else if ( a === 1 ) value = attribute.getY( i ); else if ( a === 2 ) value = attribute.getZ( i ); else if ( a === 3 ) value = attribute.getW( i );

				}

				output.min[ a ] = Math.min( output.min[ a ], value );
				output.max[ a ] = Math.max( output.max[ a ], value );

			}

		}

		return output;

	}

	/**
 * Get the required size + padding for a buffer, rounded to the next 4-byte boundary.
 * https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#data-alignment
 *
 * @param {Integer} bufferSize The size the original buffer.
 * @returns {Integer} new buffer size with required padding.
 *
 */
	function getPaddedBufferSize( bufferSize ) {

		return Math.ceil( bufferSize / 4 ) * 4;

	}

	/**
 * Returns a buffer aligned to 4-byte boundary.
 *
 * @param {ArrayBuffer} arrayBuffer Buffer to pad
 * @param {Integer} paddingByte (Optional)
 * @returns {ArrayBuffer} The same buffer if it's already aligned to 4-byte boundary or a new buffer
 */
	function getPaddedArrayBuffer( arrayBuffer, paddingByte = 0 ) {

		const paddedLength = getPaddedBufferSize( arrayBuffer.byteLength );
		if ( paddedLength !== arrayBuffer.byteLength ) {

			const array = new Uint8Array( paddedLength );
			array.set( new Uint8Array( arrayBuffer ) );
			if ( paddingByte !== 0 ) {

				for ( let i = arrayBuffer.byteLength; i < paddedLength; i ++ ) {

					array[ i ] = paddingByte;

				}

			}

			return array.buffer;

		}

		return arrayBuffer;

	}

	function getCanvas() {

		if ( typeof document === 'undefined' && typeof OffscreenCanvas !== 'undefined' ) {

			return new OffscreenCanvas( 1, 1 );

		}

		return document.createElement( 'canvas' );

	}

	function getToBlobPromise( canvas, mimeType ) {

		if ( canvas.toBlob !== undefined ) {

			return new Promise( resolve => canvas.toBlob( resolve, mimeType ) );

		}

		let quality;

		// Blink's implementation of convertToBlob seems to default to a quality level of 100%
		// Use the Blink default quality levels of toBlob instead so that file sizes are comparable.
		if ( mimeType === 'image/jpeg' ) {

			quality = 0.92;

		} else if ( mimeType === 'image/webp' ) {

			quality = 0.8;

		}

		return canvas.convertToBlob( {
			type: mimeType,
			quality: quality
		} );

	}

	/**
 * Writer
 */
	class GLTFWriter {

		constructor() {

			this.plugins = [];
			this.options = {};
			this.pending = [];
			this.buffers = [];
			this.byteOffset = 0;
			this.buffers = [];
			this.nodeMap = new Map();
			this.skins = [];
			this.extensionsUsed = {};
			this.uids = new Map();
			this.uid = 0;
			this.json = {
				asset: {
					version: '2.0',
					generator: 'THREE.GLTFExporter'
				}
			};
			this.cache = {
				meshes: new Map(),
				attributes: new Map(),
				attributesNormalized: new Map(),
				materials: new Map(),
				textures: new Map(),
				images: new Map()
			};

		}
		setPlugins( plugins ) {

			this.plugins = plugins;

		}

		/**
   * Parse scenes and generate GLTF output
   * @param  {Scene or [THREE.Scenes]} input   THREE.Scene or Array of THREE.Scenes
   * @param  {Function} onDone  Callback on completed
   * @param  {Object} options options
   */
		async write( input, onDone, options ) {

			this.options = Object.assign( {}, {
				// default options
				binary: false,
				trs: false,
				onlyVisible: true,
				maxTextureSize: Infinity,
				animations: [],
				includeCustomExtensions: false
			}, options );
			if ( this.options.animations.length > 0 ) {

				// Only TRS properties, and not matrices, may be targeted by animation.
				this.options.trs = true;

			}

			this.processInput( input );
			await Promise.all( this.pending );
			const writer = this;
			const buffers = writer.buffers;
			const json = writer.json;
			options = writer.options;
			const extensionsUsed = writer.extensionsUsed;

			// Merge buffers.
			const blob = new Blob( buffers, {
				type: 'application/octet-stream'
			} );

			// Declare extensions.
			const extensionsUsedList = Object.keys( extensionsUsed );
			if ( extensionsUsedList.length > 0 ) json.extensionsUsed = extensionsUsedList;

			// Update bytelength of the single buffer.
			if ( json.buffers && json.buffers.length > 0 ) json.buffers[ 0 ].byteLength = blob.size;
			if ( options.binary === true ) {

				// https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#glb-file-format-specification

				const reader = new FileReader();
				reader.readAsArrayBuffer( blob );
				reader.onloadend = function () {

					// Binary chunk.
					const binaryChunk = getPaddedArrayBuffer( reader.result );
					const binaryChunkPrefix = new DataView( new ArrayBuffer( GLB_CHUNK_PREFIX_BYTES ) );
					binaryChunkPrefix.setUint32( 0, binaryChunk.byteLength, true );
					binaryChunkPrefix.setUint32( 4, GLB_CHUNK_TYPE_BIN, true );

					// JSON chunk.
					const jsonChunk = getPaddedArrayBuffer( stringToArrayBuffer( JSON.stringify( json ) ), 0x20 );
					const jsonChunkPrefix = new DataView( new ArrayBuffer( GLB_CHUNK_PREFIX_BYTES ) );
					jsonChunkPrefix.setUint32( 0, jsonChunk.byteLength, true );
					jsonChunkPrefix.setUint32( 4, GLB_CHUNK_TYPE_JSON, true );

					// GLB header.
					const header = new ArrayBuffer( GLB_HEADER_BYTES );
					const headerView = new DataView( header );
					headerView.setUint32( 0, GLB_HEADER_MAGIC, true );
					headerView.setUint32( 4, GLB_VERSION, true );
					const totalByteLength = GLB_HEADER_BYTES + jsonChunkPrefix.byteLength + jsonChunk.byteLength + binaryChunkPrefix.byteLength + binaryChunk.byteLength;
					headerView.setUint32( 8, totalByteLength, true );
					const glbBlob = new Blob( [ header, jsonChunkPrefix, jsonChunk, binaryChunkPrefix, binaryChunk ], {
						type: 'application/octet-stream'
					} );
					const glbReader = new FileReader();
					glbReader.readAsArrayBuffer( glbBlob );
					glbReader.onloadend = function () {

						onDone( glbReader.result );

					};

				};

			} else {

				if ( json.buffers && json.buffers.length > 0 ) {

					const reader = new FileReader();
					reader.readAsDataURL( blob );
					reader.onloadend = function () {

						const base64data = reader.result;
						json.buffers[ 0 ].uri = base64data;
						onDone( json );

					};

				} else {

					onDone( json );

				}

			}

		}

		/**
   * Serializes a userData.
   *
   * @param {THREE.Object3D|THREE.Material} object
   * @param {Object} objectDef
   */
		serializeUserData( object, objectDef ) {

			if ( Object.keys( object.userData ).length === 0 ) return;
			const options = this.options;
			const extensionsUsed = this.extensionsUsed;
			try {

				const json = JSON.parse( JSON.stringify( object.userData ) );
				if ( options.includeCustomExtensions && json.gltfExtensions ) {

					if ( objectDef.extensions === undefined ) objectDef.extensions = {};
					for ( const extensionName in json.gltfExtensions ) {

						objectDef.extensions[ extensionName ] = json.gltfExtensions[ extensionName ];
						extensionsUsed[ extensionName ] = true;

					}

					delete json.gltfExtensions;

				}

				if ( Object.keys( json ).length > 0 ) objectDef.extras = json;

			} catch ( error ) {

				console.warn( 'THREE.GLTFExporter: userData of \'' + object.name + '\' ' + 'won\'t be serialized because of JSON.stringify error - ' + error.message );

			}

		}

		/**
   * Returns ids for buffer attributes.
   * @param  {Object} object
   * @return {Integer}
   */
		getUID( attribute, isRelativeCopy = false ) {

			if ( this.uids.has( attribute ) === false ) {

				const uids = new Map();
				uids.set( true, this.uid ++ );
				uids.set( false, this.uid ++ );
				this.uids.set( attribute, uids );

			}

			const uids = this.uids.get( attribute );
			return uids.get( isRelativeCopy );

		}

		/**
   * Checks if normal attribute values are normalized.
   *
   * @param {BufferAttribute} normal
   * @returns {Boolean}
   */
		isNormalizedNormalAttribute( normal ) {

			const cache = this.cache;
			if ( cache.attributesNormalized.has( normal ) ) return false;
			const v = new THREE.Vector3();
			for ( let i = 0, il = normal.count; i < il; i ++ ) {

				// 0.0005 is from glTF-validator
				if ( Math.abs( v.fromBufferAttribute( normal, i ).length() - 1.0 ) > 0.0005 ) return false;

			}

			return true;

		}

		/**
   * Creates normalized normal buffer attribute.
   *
   * @param {BufferAttribute} normal
   * @returns {BufferAttribute}
   *
   */
		createNormalizedNormalAttribute( normal ) {

			const cache = this.cache;
			if ( cache.attributesNormalized.has( normal ) ) return cache.attributesNormalized.get( normal );
			const attribute = normal.clone();
			const v = new THREE.Vector3();
			for ( let i = 0, il = attribute.count; i < il; i ++ ) {

				v.fromBufferAttribute( attribute, i );
				if ( v.x === 0 && v.y === 0 && v.z === 0 ) {

					// if values can't be normalized set (1, 0, 0)
					v.setX( 1.0 );

				} else {

					v.normalize();

				}

				attribute.setXYZ( i, v.x, v.y, v.z );

			}

			cache.attributesNormalized.set( normal, attribute );
			return attribute;

		}

		/**
   * Applies a texture transform, if present, to the map definition. Requires
   * the KHR_texture_transform extension.
   *
   * @param {Object} mapDef
   * @param {THREE.Texture} texture
   */
		applyTextureTransform( mapDef, texture ) {

			let didTransform = false;
			const transformDef = {};
			if ( texture.offset.x !== 0 || texture.offset.y !== 0 ) {

				transformDef.offset = texture.offset.toArray();
				didTransform = true;

			}

			if ( texture.rotation !== 0 ) {

				transformDef.rotation = texture.rotation;
				didTransform = true;

			}

			if ( texture.repeat.x !== 1 || texture.repeat.y !== 1 ) {

				transformDef.scale = texture.repeat.toArray();
				didTransform = true;

			}

			if ( didTransform ) {

				mapDef.extensions = mapDef.extensions || {};
				mapDef.extensions[ 'KHR_texture_transform' ] = transformDef;
				this.extensionsUsed[ 'KHR_texture_transform' ] = true;

			}

		}
		buildMetalRoughTexture( metalnessMap, roughnessMap ) {

			if ( metalnessMap === roughnessMap ) return metalnessMap;
			function getEncodingConversion( map ) {

				if ( map.encoding === THREE.sRGBEncoding ) {

					return function SRGBToLinear( c ) {

						return c < 0.04045 ? c * 0.0773993808 : Math.pow( c * 0.9478672986 + 0.0521327014, 2.4 );

					};

				}

				return function LinearToLinear( c ) {

					return c;

				};

			}

			console.warn( 'THREE.GLTFExporter: Merged metalnessMap and roughnessMap textures.' );
			const metalness = metalnessMap?.image;
			const roughness = roughnessMap?.image;
			const width = Math.max( metalness?.width || 0, roughness?.width || 0 );
			const height = Math.max( metalness?.height || 0, roughness?.height || 0 );
			const canvas = getCanvas();
			canvas.width = width;
			canvas.height = height;
			const context = canvas.getContext( '2d' );
			context.fillStyle = '#00ffff';
			context.fillRect( 0, 0, width, height );
			const composite = context.getImageData( 0, 0, width, height );
			if ( metalness ) {

				context.drawImage( metalness, 0, 0, width, height );
				const convert = getEncodingConversion( metalnessMap );
				const data = context.getImageData( 0, 0, width, height ).data;
				for ( let i = 2; i < data.length; i += 4 ) {

					composite.data[ i ] = convert( data[ i ] / 256 ) * 256;

				}

			}

			if ( roughness ) {

				context.drawImage( roughness, 0, 0, width, height );
				const convert = getEncodingConversion( roughnessMap );
				const data = context.getImageData( 0, 0, width, height ).data;
				for ( let i = 1; i < data.length; i += 4 ) {

					composite.data[ i ] = convert( data[ i ] / 256 ) * 256;

				}

			}

			context.putImageData( composite, 0, 0 );

			//

			const reference = metalnessMap || roughnessMap;
			const texture = reference.clone();
			texture.source = new THREE.Source( canvas );
			texture.encoding = THREE.LinearEncoding;
			return texture;

		}

		/**
   * Process a buffer to append to the default one.
   * @param  {ArrayBuffer} buffer
   * @return {Integer}
   */
		processBuffer( buffer ) {

			const json = this.json;
			const buffers = this.buffers;
			if ( ! json.buffers ) json.buffers = [ {
				byteLength: 0
			} ];

			// All buffers are merged before export.
			buffers.push( buffer );
			return 0;

		}

		/**
   * Process and generate a BufferView
   * @param  {BufferAttribute} attribute
   * @param  {number} componentType
   * @param  {number} start
   * @param  {number} count
   * @param  {number} target (Optional) Target usage of the BufferView
   * @return {Object}
   */
		processBufferView( attribute, componentType, start, count, target ) {

			const json = this.json;
			if ( ! json.bufferViews ) json.bufferViews = [];

			// Create a new dataview and dump the attribute's array into it

			let componentSize;
			if ( componentType === WEBGL_CONSTANTS.UNSIGNED_BYTE ) {

				componentSize = 1;

			} else if ( componentType === WEBGL_CONSTANTS.UNSIGNED_SHORT ) {

				componentSize = 2;

			} else {

				componentSize = 4;

			}

			const byteLength = getPaddedBufferSize( count * attribute.itemSize * componentSize );
			const dataView = new DataView( new ArrayBuffer( byteLength ) );
			let offset = 0;
			for ( let i = start; i < start + count; i ++ ) {

				for ( let a = 0; a < attribute.itemSize; a ++ ) {

					let value;
					if ( attribute.itemSize > 4 ) {

						// no support for interleaved data for itemSize > 4

						value = attribute.array[ i * attribute.itemSize + a ];

					} else {

						if ( a === 0 ) value = attribute.getX( i ); else if ( a === 1 ) value = attribute.getY( i ); else if ( a === 2 ) value = attribute.getZ( i ); else if ( a === 3 ) value = attribute.getW( i );

					}

					if ( componentType === WEBGL_CONSTANTS.FLOAT ) {

						dataView.setFloat32( offset, value, true );

					} else if ( componentType === WEBGL_CONSTANTS.UNSIGNED_INT ) {

						dataView.setUint32( offset, value, true );

					} else if ( componentType === WEBGL_CONSTANTS.UNSIGNED_SHORT ) {

						dataView.setUint16( offset, value, true );

					} else if ( componentType === WEBGL_CONSTANTS.UNSIGNED_BYTE ) {

						dataView.setUint8( offset, value );

					}

					offset += componentSize;

				}

			}

			const bufferViewDef = {
				buffer: this.processBuffer( dataView.buffer ),
				byteOffset: this.byteOffset,
				byteLength: byteLength
			};
			if ( target !== undefined ) bufferViewDef.target = target;
			if ( target === WEBGL_CONSTANTS.ARRAY_BUFFER ) {

				// Only define byteStride for vertex attributes.
				bufferViewDef.byteStride = attribute.itemSize * componentSize;

			}

			this.byteOffset += byteLength;
			json.bufferViews.push( bufferViewDef );

			// @TODO Merge bufferViews where possible.
			const output = {
				id: json.bufferViews.length - 1,
				byteLength: 0
			};
			return output;

		}

		/**
   * Process and generate a BufferView from an image Blob.
   * @param {Blob} blob
   * @return {Promise<Integer>}
   */
		processBufferViewImage( blob ) {

			const writer = this;
			const json = writer.json;
			if ( ! json.bufferViews ) json.bufferViews = [];
			return new Promise( function ( resolve ) {

				const reader = new FileReader();
				reader.readAsArrayBuffer( blob );
				reader.onloadend = function () {

					const buffer = getPaddedArrayBuffer( reader.result );
					const bufferViewDef = {
						buffer: writer.processBuffer( buffer ),
						byteOffset: writer.byteOffset,
						byteLength: buffer.byteLength
					};
					writer.byteOffset += buffer.byteLength;
					resolve( json.bufferViews.push( bufferViewDef ) - 1 );

				};

			} );

		}

		/**
   * Process attribute to generate an accessor
   * @param  {BufferAttribute} attribute Attribute to process
   * @param  {THREE.BufferGeometry} geometry (Optional) Geometry used for truncated draw range
   * @param  {Integer} start (Optional)
   * @param  {Integer} count (Optional)
   * @return {Integer|null} Index of the processed accessor on the "accessors" array
   */
		processAccessor( attribute, geometry, start, count ) {

			const json = this.json;
			const types = {
				1: 'SCALAR',
				2: 'VEC2',
				3: 'VEC3',
				4: 'VEC4',
				16: 'MAT4'
			};
			let componentType;

			// Detect the component type of the attribute array (float, uint or ushort)
			if ( attribute.array.constructor === Float32Array ) {

				componentType = WEBGL_CONSTANTS.FLOAT;

			} else if ( attribute.array.constructor === Uint32Array ) {

				componentType = WEBGL_CONSTANTS.UNSIGNED_INT;

			} else if ( attribute.array.constructor === Uint16Array ) {

				componentType = WEBGL_CONSTANTS.UNSIGNED_SHORT;

			} else if ( attribute.array.constructor === Uint8Array ) {

				componentType = WEBGL_CONSTANTS.UNSIGNED_BYTE;

			} else {

				throw new Error( 'THREE.GLTFExporter: Unsupported bufferAttribute component type.' );

			}

			if ( start === undefined ) start = 0;
			if ( count === undefined ) count = attribute.count;

			// Skip creating an accessor if the attribute doesn't have data to export
			if ( count === 0 ) return null;
			const minMax = getMinMax( attribute, start, count );
			let bufferViewTarget;

			// If geometry isn't provided, don't infer the target usage of the bufferView. For
			// animation samplers, target must not be set.
			if ( geometry !== undefined ) {

				bufferViewTarget = attribute === geometry.index ? WEBGL_CONSTANTS.ELEMENT_ARRAY_BUFFER : WEBGL_CONSTANTS.ARRAY_BUFFER;

			}

			const bufferView = this.processBufferView( attribute, componentType, start, count, bufferViewTarget );
			const accessorDef = {
				bufferView: bufferView.id,
				byteOffset: bufferView.byteOffset,
				componentType: componentType,
				count: count,
				max: minMax.max,
				min: minMax.min,
				type: types[ attribute.itemSize ]
			};
			if ( attribute.normalized === true ) accessorDef.normalized = true;
			if ( ! json.accessors ) json.accessors = [];
			return json.accessors.push( accessorDef ) - 1;

		}

		/**
   * Process image
   * @param  {Image} image to process
   * @param  {Integer} format of the image (THREE.RGBAFormat)
   * @param  {Boolean} flipY before writing out the image
   * @param  {String} mimeType export format
   * @return {Integer}     Index of the processed texture in the "images" array
   */
		processImage( image, format, flipY, mimeType = 'image/png' ) {

			const writer = this;
			const cache = writer.cache;
			const json = writer.json;
			const options = writer.options;
			const pending = writer.pending;
			if ( ! cache.images.has( image ) ) cache.images.set( image, {} );
			const cachedImages = cache.images.get( image );
			const key = mimeType + ':flipY/' + flipY.toString();
			if ( cachedImages[ key ] !== undefined ) return cachedImages[ key ];
			if ( ! json.images ) json.images = [];
			const imageDef = {
				mimeType: mimeType
			};
			const canvas = getCanvas();
			canvas.width = Math.min( image.width, options.maxTextureSize );
			canvas.height = Math.min( image.height, options.maxTextureSize );
			const ctx = canvas.getContext( '2d' );
			if ( flipY === true ) {

				ctx.translate( 0, canvas.height );
				ctx.scale( 1, - 1 );

			}

			if ( image.data !== undefined ) {

				// THREE.DataTexture

				if ( format !== THREE.RGBAFormat ) {

					console.error( 'GLTFExporter: Only THREE.RGBAFormat is supported.' );

				}

				if ( image.width > options.maxTextureSize || image.height > options.maxTextureSize ) {

					console.warn( 'GLTFExporter: Image size is bigger than maxTextureSize', image );

				}

				const data = new Uint8ClampedArray( image.height * image.width * 4 );
				for ( let i = 0; i < data.length; i += 4 ) {

					data[ i + 0 ] = image.data[ i + 0 ];
					data[ i + 1 ] = image.data[ i + 1 ];
					data[ i + 2 ] = image.data[ i + 2 ];
					data[ i + 3 ] = image.data[ i + 3 ];

				}

				ctx.putImageData( new ImageData( data, image.width, image.height ), 0, 0 );

			} else {

				ctx.drawImage( image, 0, 0, canvas.width, canvas.height );

			}

			if ( options.binary === true ) {

				pending.push( getToBlobPromise( canvas, mimeType ).then( blob => writer.processBufferViewImage( blob ) ).then( bufferViewIndex => {

					imageDef.bufferView = bufferViewIndex;

				} ) );

			} else {

				if ( canvas.toDataURL !== undefined ) {

					imageDef.uri = canvas.toDataURL( mimeType );

				} else {

					pending.push( getToBlobPromise( canvas, mimeType ).then( blob => new FileReader().readAsDataURL( blob ) ).then( dataURL => {

						imageDef.uri = dataURL;

					} ) );

				}

			}

			const index = json.images.push( imageDef ) - 1;
			cachedImages[ key ] = index;
			return index;

		}

		/**
   * Process sampler
   * @param  {Texture} map Texture to process
   * @return {Integer}     Index of the processed texture in the "samplers" array
   */
		processSampler( map ) {

			const json = this.json;
			if ( ! json.samplers ) json.samplers = [];
			const samplerDef = {
				magFilter: THREE_TO_WEBGL[ map.magFilter ],
				minFilter: THREE_TO_WEBGL[ map.minFilter ],
				wrapS: THREE_TO_WEBGL[ map.wrapS ],
				wrapT: THREE_TO_WEBGL[ map.wrapT ]
			};
			return json.samplers.push( samplerDef ) - 1;

		}

		/**
   * Process texture
   * @param  {Texture} map Map to process
   * @return {Integer} Index of the processed texture in the "textures" array
   */
		processTexture( map ) {

			const cache = this.cache;
			const json = this.json;
			if ( cache.textures.has( map ) ) return cache.textures.get( map );
			if ( ! json.textures ) json.textures = [];
			let mimeType = map.userData.mimeType;
			if ( mimeType === 'image/webp' ) mimeType = 'image/png';
			const textureDef = {
				sampler: this.processSampler( map ),
				source: this.processImage( map.image, map.format, map.flipY, mimeType )
			};
			if ( map.name ) textureDef.name = map.name;
			this._invokeAll( function ( ext ) {

				ext.writeTexture && ext.writeTexture( map, textureDef );

			} );
			const index = json.textures.push( textureDef ) - 1;
			cache.textures.set( map, index );
			return index;

		}

		/**
   * Process material
   * @param  {THREE.Material} material Material to process
   * @return {Integer|null} Index of the processed material in the "materials" array
   */
		processMaterial( material ) {

			const cache = this.cache;
			const json = this.json;
			if ( cache.materials.has( material ) ) return cache.materials.get( material );
			if ( material.isShaderMaterial ) {

				console.warn( 'GLTFExporter: THREE.ShaderMaterial not supported.' );
				return null;

			}

			if ( ! json.materials ) json.materials = [];

			// @QUESTION Should we avoid including any attribute that has the default value?
			const materialDef = {
				pbrMetallicRoughness: {}
			};
			if ( material.isMeshStandardMaterial !== true && material.isMeshBasicMaterial !== true ) {

				console.warn( 'GLTFExporter: Use MeshStandardMaterial or MeshBasicMaterial for best results.' );

			}

			// pbrMetallicRoughness.baseColorFactor
			const color = material.color.toArray().concat( [ material.opacity ] );
			if ( ! equalArray( color, [ 1, 1, 1, 1 ] ) ) {

				materialDef.pbrMetallicRoughness.baseColorFactor = color;

			}

			if ( material.isMeshStandardMaterial ) {

				materialDef.pbrMetallicRoughness.metallicFactor = material.metalness;
				materialDef.pbrMetallicRoughness.roughnessFactor = material.roughness;

			} else {

				materialDef.pbrMetallicRoughness.metallicFactor = 0.5;
				materialDef.pbrMetallicRoughness.roughnessFactor = 0.5;

			}

			// pbrMetallicRoughness.metallicRoughnessTexture
			if ( material.metalnessMap || material.roughnessMap ) {

				const metalRoughTexture = this.buildMetalRoughTexture( material.metalnessMap, material.roughnessMap );
				const metalRoughMapDef = {
					index: this.processTexture( metalRoughTexture )
				};
				this.applyTextureTransform( metalRoughMapDef, metalRoughTexture );
				materialDef.pbrMetallicRoughness.metallicRoughnessTexture = metalRoughMapDef;

			}

			// pbrMetallicRoughness.baseColorTexture or pbrSpecularGlossiness diffuseTexture
			if ( material.map ) {

				const baseColorMapDef = {
					index: this.processTexture( material.map )
				};
				this.applyTextureTransform( baseColorMapDef, material.map );
				materialDef.pbrMetallicRoughness.baseColorTexture = baseColorMapDef;

			}

			if ( material.emissive ) {

				// note: emissive components are limited to stay within the 0 - 1 range to accommodate glTF spec. see #21849 and #22000.
				const emissive = material.emissive.clone().multiplyScalar( material.emissiveIntensity );
				const maxEmissiveComponent = Math.max( emissive.r, emissive.g, emissive.b );
				if ( maxEmissiveComponent > 1 ) {

					emissive.multiplyScalar( 1 / maxEmissiveComponent );
					console.warn( 'THREE.GLTFExporter: Some emissive components exceed 1; emissive has been limited' );

				}

				if ( maxEmissiveComponent > 0 ) {

					materialDef.emissiveFactor = emissive.toArray();

				}

				// emissiveTexture
				if ( material.emissiveMap ) {

					const emissiveMapDef = {
						index: this.processTexture( material.emissiveMap )
					};
					this.applyTextureTransform( emissiveMapDef, material.emissiveMap );
					materialDef.emissiveTexture = emissiveMapDef;

				}

			}

			// normalTexture
			if ( material.normalMap ) {

				const normalMapDef = {
					index: this.processTexture( material.normalMap )
				};
				if ( material.normalScale && material.normalScale.x !== 1 ) {

					// glTF normal scale is univariate. Ignore `y`, which may be flipped.
					// Context: https://github.com/mrdoob/three.js/issues/11438#issuecomment-507003995
					normalMapDef.scale = material.normalScale.x;

				}

				this.applyTextureTransform( normalMapDef, material.normalMap );
				materialDef.normalTexture = normalMapDef;

			}

			// occlusionTexture
			if ( material.aoMap ) {

				const occlusionMapDef = {
					index: this.processTexture( material.aoMap ),
					texCoord: 1
				};
				if ( material.aoMapIntensity !== 1.0 ) {

					occlusionMapDef.strength = material.aoMapIntensity;

				}

				this.applyTextureTransform( occlusionMapDef, material.aoMap );
				materialDef.occlusionTexture = occlusionMapDef;

			}

			// alphaMode
			if ( material.transparent ) {

				materialDef.alphaMode = 'BLEND';

			} else {

				if ( material.alphaTest > 0.0 ) {

					materialDef.alphaMode = 'MASK';
					materialDef.alphaCutoff = material.alphaTest;

				}

			}

			// doubleSided
			if ( material.side === THREE.DoubleSide ) materialDef.doubleSided = true;
			if ( material.name !== '' ) materialDef.name = material.name;
			this.serializeUserData( material, materialDef );
			this._invokeAll( function ( ext ) {

				ext.writeMaterial && ext.writeMaterial( material, materialDef );

			} );
			const index = json.materials.push( materialDef ) - 1;
			cache.materials.set( material, index );
			return index;

		}

		/**
   * Process mesh
   * @param  {THREE.Mesh} mesh Mesh to process
   * @return {Integer|null} Index of the processed mesh in the "meshes" array
   */
		processMesh( mesh ) {

			const cache = this.cache;
			const json = this.json;
			const meshCacheKeyParts = [ mesh.geometry.uuid ];
			if ( Array.isArray( mesh.material ) ) {

				for ( let i = 0, l = mesh.material.length; i < l; i ++ ) {

					meshCacheKeyParts.push( mesh.material[ i ].uuid );

				}

			} else {

				meshCacheKeyParts.push( mesh.material.uuid );

			}

			const meshCacheKey = meshCacheKeyParts.join( ':' );
			if ( cache.meshes.has( meshCacheKey ) ) return cache.meshes.get( meshCacheKey );
			const geometry = mesh.geometry;
			let mode;

			// Use the correct mode
			if ( mesh.isLineSegments ) {

				mode = WEBGL_CONSTANTS.LINES;

			} else if ( mesh.isLineLoop ) {

				mode = WEBGL_CONSTANTS.LINE_LOOP;

			} else if ( mesh.isLine ) {

				mode = WEBGL_CONSTANTS.LINE_STRIP;

			} else if ( mesh.isPoints ) {

				mode = WEBGL_CONSTANTS.POINTS;

			} else {

				mode = mesh.material.wireframe ? WEBGL_CONSTANTS.LINES : WEBGL_CONSTANTS.TRIANGLES;

			}

			const meshDef = {};
			const attributes = {};
			const primitives = [];
			const targets = [];

			// Conversion between attributes names in threejs and gltf spec
			const nameConversion = {
				uv: 'TEXCOORD_0',
				uv2: 'TEXCOORD_1',
				color: 'COLOR_0',
				skinWeight: 'WEIGHTS_0',
				skinIndex: 'JOINTS_0'
			};
			const originalNormal = geometry.getAttribute( 'normal' );
			if ( originalNormal !== undefined && ! this.isNormalizedNormalAttribute( originalNormal ) ) {

				console.warn( 'THREE.GLTFExporter: Creating normalized normal attribute from the non-normalized one.' );
				geometry.setAttribute( 'normal', this.createNormalizedNormalAttribute( originalNormal ) );

			}

			// @QUESTION Detect if .vertexColors = true?
			// For every attribute create an accessor
			let modifiedAttribute = null;
			for ( let attributeName in geometry.attributes ) {

				// Ignore morph target attributes, which are exported later.
				if ( attributeName.slice( 0, 5 ) === 'morph' ) continue;
				const attribute = geometry.attributes[ attributeName ];
				attributeName = nameConversion[ attributeName ] || attributeName.toUpperCase();

				// Prefix all geometry attributes except the ones specifically
				// listed in the spec; non-spec attributes are considered custom.
				const validVertexAttributes = /^(POSITION|NORMAL|TANGENT|TEXCOORD_\d+|COLOR_\d+|JOINTS_\d+|WEIGHTS_\d+)$/;
				if ( ! validVertexAttributes.test( attributeName ) ) attributeName = '_' + attributeName;
				if ( cache.attributes.has( this.getUID( attribute ) ) ) {

					attributes[ attributeName ] = cache.attributes.get( this.getUID( attribute ) );
					continue;

				}

				// JOINTS_0 must be UNSIGNED_BYTE or UNSIGNED_SHORT.
				modifiedAttribute = null;
				const array = attribute.array;
				if ( attributeName === 'JOINTS_0' && ! ( array instanceof Uint16Array ) && ! ( array instanceof Uint8Array ) ) {

					console.warn( 'GLTFExporter: Attribute "skinIndex" converted to type UNSIGNED_SHORT.' );
					modifiedAttribute = new THREE.BufferAttribute( new Uint16Array( array ), attribute.itemSize, attribute.normalized );

				}

				const accessor = this.processAccessor( modifiedAttribute || attribute, geometry );
				if ( accessor !== null ) {

					attributes[ attributeName ] = accessor;
					cache.attributes.set( this.getUID( attribute ), accessor );

				}

			}

			if ( originalNormal !== undefined ) geometry.setAttribute( 'normal', originalNormal );

			// Skip if no exportable attributes found
			if ( Object.keys( attributes ).length === 0 ) return null;

			// Morph targets
			if ( mesh.morphTargetInfluences !== undefined && mesh.morphTargetInfluences.length > 0 ) {

				const weights = [];
				const targetNames = [];
				const reverseDictionary = {};
				if ( mesh.morphTargetDictionary !== undefined ) {

					for ( const key in mesh.morphTargetDictionary ) {

						reverseDictionary[ mesh.morphTargetDictionary[ key ] ] = key;

					}

				}

				for ( let i = 0; i < mesh.morphTargetInfluences.length; ++ i ) {

					const target = {};
					let warned = false;
					for ( const attributeName in geometry.morphAttributes ) {

						// glTF 2.0 morph supports only POSITION/NORMAL/TANGENT.
						// Three.js doesn't support TANGENT yet.

						if ( attributeName !== 'position' && attributeName !== 'normal' ) {

							if ( ! warned ) {

								console.warn( 'GLTFExporter: Only POSITION and NORMAL morph are supported.' );
								warned = true;

							}

							continue;

						}

						const attribute = geometry.morphAttributes[ attributeName ][ i ];
						const gltfAttributeName = attributeName.toUpperCase();

						// Three.js morph attribute has absolute values while the one of glTF has relative values.
						//
						// glTF 2.0 Specification:
						// https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#morph-targets

						const baseAttribute = geometry.attributes[ attributeName ];
						if ( cache.attributes.has( this.getUID( attribute, true ) ) ) {

							target[ gltfAttributeName ] = cache.attributes.get( this.getUID( attribute, true ) );
							continue;

						}

						// Clones attribute not to override
						const relativeAttribute = attribute.clone();
						if ( ! geometry.morphTargetsRelative ) {

							for ( let j = 0, jl = attribute.count; j < jl; j ++ ) {

								relativeAttribute.setXYZ( j, attribute.getX( j ) - baseAttribute.getX( j ), attribute.getY( j ) - baseAttribute.getY( j ), attribute.getZ( j ) - baseAttribute.getZ( j ) );

							}

						}

						target[ gltfAttributeName ] = this.processAccessor( relativeAttribute, geometry );
						cache.attributes.set( this.getUID( baseAttribute, true ), target[ gltfAttributeName ] );

					}

					targets.push( target );
					weights.push( mesh.morphTargetInfluences[ i ] );
					if ( mesh.morphTargetDictionary !== undefined ) targetNames.push( reverseDictionary[ i ] );

				}

				meshDef.weights = weights;
				if ( targetNames.length > 0 ) {

					meshDef.extras = {};
					meshDef.extras.targetNames = targetNames;

				}

			}

			const isMultiMaterial = Array.isArray( mesh.material );
			if ( isMultiMaterial && geometry.groups.length === 0 ) return null;
			const materials = isMultiMaterial ? mesh.material : [ mesh.material ];
			const groups = isMultiMaterial ? geometry.groups : [ {
				materialIndex: 0,
				start: undefined,
				count: undefined
			} ];
			for ( let i = 0, il = groups.length; i < il; i ++ ) {

				const primitive = {
					mode: mode,
					attributes: attributes
				};
				this.serializeUserData( geometry, primitive );
				if ( targets.length > 0 ) primitive.targets = targets;
				if ( geometry.index !== null ) {

					let cacheKey = this.getUID( geometry.index );
					if ( groups[ i ].start !== undefined || groups[ i ].count !== undefined ) {

						cacheKey += ':' + groups[ i ].start + ':' + groups[ i ].count;

					}

					if ( cache.attributes.has( cacheKey ) ) {

						primitive.indices = cache.attributes.get( cacheKey );

					} else {

						primitive.indices = this.processAccessor( geometry.index, geometry, groups[ i ].start, groups[ i ].count );
						cache.attributes.set( cacheKey, primitive.indices );

					}

					if ( primitive.indices === null ) delete primitive.indices;

				}

				const material = this.processMaterial( materials[ groups[ i ].materialIndex ] );
				if ( material !== null ) primitive.material = material;
				primitives.push( primitive );

			}

			meshDef.primitives = primitives;
			if ( ! json.meshes ) json.meshes = [];
			this._invokeAll( function ( ext ) {

				ext.writeMesh && ext.writeMesh( mesh, meshDef );

			} );
			const index = json.meshes.push( meshDef ) - 1;
			cache.meshes.set( meshCacheKey, index );
			return index;

		}

		/**
   * Process camera
   * @param  {THREE.Camera} camera Camera to process
   * @return {Integer}      Index of the processed mesh in the "camera" array
   */
		processCamera( camera ) {

			const json = this.json;
			if ( ! json.cameras ) json.cameras = [];
			const isOrtho = camera.isOrthographicCamera;
			const cameraDef = {
				type: isOrtho ? 'orthographic' : 'perspective'
			};
			if ( isOrtho ) {

				cameraDef.orthographic = {
					xmag: camera.right * 2,
					ymag: camera.top * 2,
					zfar: camera.far <= 0 ? 0.001 : camera.far,
					znear: camera.near < 0 ? 0 : camera.near
				};

			} else {

				cameraDef.perspective = {
					aspectRatio: camera.aspect,
					yfov: THREE.MathUtils.degToRad( camera.fov ),
					zfar: camera.far <= 0 ? 0.001 : camera.far,
					znear: camera.near < 0 ? 0 : camera.near
				};

			}

			// Question: Is saving "type" as name intentional?
			if ( camera.name !== '' ) cameraDef.name = camera.type;
			return json.cameras.push( cameraDef ) - 1;

		}

		/**
   * Creates glTF animation entry from AnimationClip object.
   *
   * Status:
   * - Only properties listed in PATH_PROPERTIES may be animated.
   *
   * @param {THREE.AnimationClip} clip
   * @param {THREE.Object3D} root
   * @return {number|null}
   */
		processAnimation( clip, root ) {

			const json = this.json;
			const nodeMap = this.nodeMap;
			if ( ! json.animations ) json.animations = [];
			clip = GLTFExporter.Utils.mergeMorphTargetTracks( clip.clone(), root );
			const tracks = clip.tracks;
			const channels = [];
			const samplers = [];
			for ( let i = 0; i < tracks.length; ++ i ) {

				const track = tracks[ i ];
				const trackBinding = THREE.PropertyBinding.parseTrackName( track.name );
				let trackNode = THREE.PropertyBinding.findNode( root, trackBinding.nodeName );
				const trackProperty = PATH_PROPERTIES[ trackBinding.propertyName ];
				if ( trackBinding.objectName === 'bones' ) {

					if ( trackNode.isSkinnedMesh === true ) {

						trackNode = trackNode.skeleton.getBoneByName( trackBinding.objectIndex );

					} else {

						trackNode = undefined;

					}

				}

				if ( ! trackNode || ! trackProperty ) {

					console.warn( 'THREE.GLTFExporter: Could not export animation track "%s".', track.name );
					return null;

				}

				const inputItemSize = 1;
				let outputItemSize = track.values.length / track.times.length;
				if ( trackProperty === PATH_PROPERTIES.morphTargetInfluences ) {

					outputItemSize /= trackNode.morphTargetInfluences.length;

				}

				let interpolation;

				// @TODO export CubicInterpolant(InterpolateSmooth) as CUBICSPLINE

				// Detecting glTF cubic spline interpolant by checking factory method's special property
				// GLTFCubicSplineInterpolant is a custom interpolant and track doesn't return
				// valid value from .getInterpolation().
				if ( track.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline === true ) {

					interpolation = 'CUBICSPLINE';

					// itemSize of CUBICSPLINE keyframe is 9
					// (VEC3 * 3: inTangent, splineVertex, and outTangent)
					// but needs to be stored as VEC3 so dividing by 3 here.
					outputItemSize /= 3;

				} else if ( track.getInterpolation() === THREE.InterpolateDiscrete ) {

					interpolation = 'STEP';

				} else {

					interpolation = 'LINEAR';

				}

				samplers.push( {
					input: this.processAccessor( new THREE.BufferAttribute( track.times, inputItemSize ) ),
					output: this.processAccessor( new THREE.BufferAttribute( track.values, outputItemSize ) ),
					interpolation: interpolation
				} );
				channels.push( {
					sampler: samplers.length - 1,
					target: {
						node: nodeMap.get( trackNode ),
						path: trackProperty
					}
				} );

			}

			json.animations.push( {
				name: clip.name || 'clip_' + json.animations.length,
				samplers: samplers,
				channels: channels
			} );
			return json.animations.length - 1;

		}

		/**
   * @param {THREE.Object3D} object
   * @return {number|null}
   */
		processSkin( object ) {

			const json = this.json;
			const nodeMap = this.nodeMap;
			const node = json.nodes[ nodeMap.get( object ) ];
			const skeleton = object.skeleton;
			if ( skeleton === undefined ) return null;
			const rootJoint = object.skeleton.bones[ 0 ];
			if ( rootJoint === undefined ) return null;
			const joints = [];
			const inverseBindMatrices = new Float32Array( skeleton.bones.length * 16 );
			const temporaryBoneInverse = new THREE.Matrix4();
			for ( let i = 0; i < skeleton.bones.length; ++ i ) {

				joints.push( nodeMap.get( skeleton.bones[ i ] ) );
				temporaryBoneInverse.copy( skeleton.boneInverses[ i ] );
				temporaryBoneInverse.multiply( object.bindMatrix ).toArray( inverseBindMatrices, i * 16 );

			}

			if ( json.skins === undefined ) json.skins = [];
			json.skins.push( {
				inverseBindMatrices: this.processAccessor( new THREE.BufferAttribute( inverseBindMatrices, 16 ) ),
				joints: joints,
				skeleton: nodeMap.get( rootJoint )
			} );
			const skinIndex = node.skin = json.skins.length - 1;
			return skinIndex;

		}

		/**
   * Process Object3D node
   * @param  {THREE.Object3D} node Object3D to processNode
   * @return {Integer} Index of the node in the nodes list
   */
		processNode( object ) {

			const json = this.json;
			const options = this.options;
			const nodeMap = this.nodeMap;
			if ( ! json.nodes ) json.nodes = [];
			const nodeDef = {};
			if ( options.trs ) {

				const rotation = object.quaternion.toArray();
				const position = object.position.toArray();
				const scale = object.scale.toArray();
				if ( ! equalArray( rotation, [ 0, 0, 0, 1 ] ) ) {

					nodeDef.rotation = rotation;

				}

				if ( ! equalArray( position, [ 0, 0, 0 ] ) ) {

					nodeDef.translation = position;

				}

				if ( ! equalArray( scale, [ 1, 1, 1 ] ) ) {

					nodeDef.scale = scale;

				}

			} else {

				if ( object.matrixAutoUpdate ) {

					object.updateMatrix();

				}

				if ( isIdentityMatrix( object.matrix ) === false ) {

					nodeDef.matrix = object.matrix.elements;

				}

			}

			// We don't export empty strings name because it represents no-name in Three.js.
			if ( object.name !== '' ) nodeDef.name = String( object.name );
			this.serializeUserData( object, nodeDef );
			if ( object.isMesh || object.isLine || object.isPoints ) {

				const meshIndex = this.processMesh( object );
				if ( meshIndex !== null ) nodeDef.mesh = meshIndex;

			} else if ( object.isCamera ) {

				nodeDef.camera = this.processCamera( object );

			}

			if ( object.isSkinnedMesh ) this.skins.push( object );
			if ( object.children.length > 0 ) {

				const children = [];
				for ( let i = 0, l = object.children.length; i < l; i ++ ) {

					const child = object.children[ i ];
					if ( child.visible || options.onlyVisible === false ) {

						const nodeIndex = this.processNode( child );
						if ( nodeIndex !== null ) children.push( nodeIndex );

					}

				}

				if ( children.length > 0 ) nodeDef.children = children;

			}

			this._invokeAll( function ( ext ) {

				ext.writeNode && ext.writeNode( object, nodeDef );

			} );
			const nodeIndex = json.nodes.push( nodeDef ) - 1;
			nodeMap.set( object, nodeIndex );
			return nodeIndex;

		}

		/**
   * Process THREE.Scene
   * @param  {Scene} node THREE.Scene to process
   */
		processScene( scene ) {

			const json = this.json;
			const options = this.options;
			if ( ! json.scenes ) {

				json.scenes = [];
				json.scene = 0;

			}

			const sceneDef = {};
			if ( scene.name !== '' ) sceneDef.name = scene.name;
			json.scenes.push( sceneDef );
			const nodes = [];
			for ( let i = 0, l = scene.children.length; i < l; i ++ ) {

				const child = scene.children[ i ];
				if ( child.visible || options.onlyVisible === false ) {

					const nodeIndex = this.processNode( child );
					if ( nodeIndex !== null ) nodes.push( nodeIndex );

				}

			}

			if ( nodes.length > 0 ) sceneDef.nodes = nodes;
			this.serializeUserData( scene, sceneDef );

		}

		/**
   * Creates a THREE.Scene to hold a list of objects and parse it
   * @param  {Array} objects List of objects to process
   */
		processObjects( objects ) {

			const scene = new THREE.Scene();
			scene.name = 'AuxScene';
			for ( let i = 0; i < objects.length; i ++ ) {

				// We push directly to children instead of calling `add` to prevent
				// modify the .parent and break its original scene and hierarchy
				scene.children.push( objects[ i ] );

			}

			this.processScene( scene );

		}

		/**
   * @param {THREE.Object3D|Array<THREE.Object3D>} input
   */
		processInput( input ) {

			const options = this.options;
			input = input instanceof Array ? input : [ input ];
			this._invokeAll( function ( ext ) {

				ext.beforeParse && ext.beforeParse( input );

			} );
			const objectsWithoutScene = [];
			for ( let i = 0; i < input.length; i ++ ) {

				if ( input[ i ] instanceof THREE.Scene ) {

					this.processScene( input[ i ] );

				} else {

					objectsWithoutScene.push( input[ i ] );

				}

			}

			if ( objectsWithoutScene.length > 0 ) this.processObjects( objectsWithoutScene );
			for ( let i = 0; i < this.skins.length; ++ i ) {

				this.processSkin( this.skins[ i ] );

			}

			for ( let i = 0; i < options.animations.length; ++ i ) {

				this.processAnimation( options.animations[ i ], input[ 0 ] );

			}

			this._invokeAll( function ( ext ) {

				ext.afterParse && ext.afterParse( input );

			} );

		}
		_invokeAll( func ) {

			for ( let i = 0, il = this.plugins.length; i < il; i ++ ) {

				func( this.plugins[ i ] );

			}

		}

	}

	/**
 * Punctual Lights Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_lights_punctual
 */
	class GLTFLightExtension {

		constructor( writer ) {

			this.writer = writer;
			this.name = 'KHR_lights_punctual';

		}
		writeNode( light, nodeDef ) {

			if ( ! light.isLight ) return;
			if ( ! light.isDirectionalLight && ! light.isPointLight && ! light.isSpotLight ) {

				console.warn( 'THREE.GLTFExporter: Only directional, point, and spot lights are supported.', light );
				return;

			}

			const writer = this.writer;
			const json = writer.json;
			const extensionsUsed = writer.extensionsUsed;
			const lightDef = {};
			if ( light.name ) lightDef.name = light.name;
			lightDef.color = light.color.toArray();
			lightDef.intensity = light.intensity;
			if ( light.isDirectionalLight ) {

				lightDef.type = 'directional';

			} else if ( light.isPointLight ) {

				lightDef.type = 'point';
				if ( light.distance > 0 ) lightDef.range = light.distance;

			} else if ( light.isSpotLight ) {

				lightDef.type = 'spot';
				if ( light.distance > 0 ) lightDef.range = light.distance;
				lightDef.spot = {};
				lightDef.spot.innerConeAngle = ( light.penumbra - 1.0 ) * light.angle * - 1.0;
				lightDef.spot.outerConeAngle = light.angle;

			}

			if ( light.decay !== undefined && light.decay !== 2 ) {

				console.warn( 'THREE.GLTFExporter: Light decay may be lost. glTF is physically-based, ' + 'and expects light.decay=2.' );

			}

			if ( light.target && ( light.target.parent !== light || light.target.position.x !== 0 || light.target.position.y !== 0 || light.target.position.z !== - 1 ) ) {

				console.warn( 'THREE.GLTFExporter: Light direction may be lost. For best results, ' + 'make light.target a child of the light with position 0,0,-1.' );

			}

			if ( ! extensionsUsed[ this.name ] ) {

				json.extensions = json.extensions || {};
				json.extensions[ this.name ] = {
					lights: []
				};
				extensionsUsed[ this.name ] = true;

			}

			const lights = json.extensions[ this.name ].lights;
			lights.push( lightDef );
			nodeDef.extensions = nodeDef.extensions || {};
			nodeDef.extensions[ this.name ] = {
				light: lights.length - 1
			};

		}

	}

	/**
 * Unlit Materials Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_unlit
 */
	class GLTFMaterialsUnlitExtension {

		constructor( writer ) {

			this.writer = writer;
			this.name = 'KHR_materials_unlit';

		}
		writeMaterial( material, materialDef ) {

			if ( ! material.isMeshBasicMaterial ) return;
			const writer = this.writer;
			const extensionsUsed = writer.extensionsUsed;
			materialDef.extensions = materialDef.extensions || {};
			materialDef.extensions[ this.name ] = {};
			extensionsUsed[ this.name ] = true;
			materialDef.pbrMetallicRoughness.metallicFactor = 0.0;
			materialDef.pbrMetallicRoughness.roughnessFactor = 0.9;

		}

	}

	/**
 * Clearcoat Materials Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_clearcoat
 */
	class GLTFMaterialsClearcoatExtension {

		constructor( writer ) {

			this.writer = writer;
			this.name = 'KHR_materials_clearcoat';

		}
		writeMaterial( material, materialDef ) {

			if ( ! material.isMeshPhysicalMaterial ) return;
			const writer = this.writer;
			const extensionsUsed = writer.extensionsUsed;
			const extensionDef = {};
			extensionDef.clearcoatFactor = material.clearcoat;
			if ( material.clearcoatMap ) {

				const clearcoatMapDef = {
					index: writer.processTexture( material.clearcoatMap )
				};
				writer.applyTextureTransform( clearcoatMapDef, material.clearcoatMap );
				extensionDef.clearcoatTexture = clearcoatMapDef;

			}

			extensionDef.clearcoatRoughnessFactor = material.clearcoatRoughness;
			if ( material.clearcoatRoughnessMap ) {

				const clearcoatRoughnessMapDef = {
					index: writer.processTexture( material.clearcoatRoughnessMap )
				};
				writer.applyTextureTransform( clearcoatRoughnessMapDef, material.clearcoatRoughnessMap );
				extensionDef.clearcoatRoughnessTexture = clearcoatRoughnessMapDef;

			}

			if ( material.clearcoatNormalMap ) {

				const clearcoatNormalMapDef = {
					index: writer.processTexture( material.clearcoatNormalMap )
				};
				writer.applyTextureTransform( clearcoatNormalMapDef, material.clearcoatNormalMap );
				extensionDef.clearcoatNormalTexture = clearcoatNormalMapDef;

			}

			materialDef.extensions = materialDef.extensions || {};
			materialDef.extensions[ this.name ] = extensionDef;
			extensionsUsed[ this.name ] = true;

		}

	}

	/**
 * Iridescence Materials Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_iridescence
 */
	class GLTFMaterialsIridescenceExtension {

		constructor( writer ) {

			this.writer = writer;
			this.name = 'KHR_materials_iridescence';

		}
		writeMaterial( material, materialDef ) {

			if ( ! material.isMeshPhysicalMaterial ) return;
			const writer = this.writer;
			const extensionsUsed = writer.extensionsUsed;
			const extensionDef = {};
			extensionDef.iridescenceFactor = material.iridescence;
			if ( material.iridescenceMap ) {

				const iridescenceMapDef = {
					index: writer.processTexture( material.iridescenceMap )
				};
				writer.applyTextureTransform( iridescenceMapDef, material.iridescenceMap );
				extensionDef.iridescenceTexture = iridescenceMapDef;

			}

			extensionDef.iridescenceIor = material.iridescenceIOR;
			extensionDef.iridescenceThicknessMinimum = material.iridescenceThicknessRange[ 0 ];
			extensionDef.iridescenceThicknessMaximum = material.iridescenceThicknessRange[ 1 ];
			if ( material.iridescenceThicknessMap ) {

				const iridescenceThicknessMapDef = {
					index: writer.processTexture( material.iridescenceThicknessMap )
				};
				writer.applyTextureTransform( iridescenceThicknessMapDef, material.iridescenceThicknessMap );
				extensionDef.iridescenceThicknessTexture = iridescenceThicknessMapDef;

			}

			materialDef.extensions = materialDef.extensions || {};
			materialDef.extensions[ this.name ] = extensionDef;
			extensionsUsed[ this.name ] = true;

		}

	}

	/**
 * Transmission Materials Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_transmission
 */
	class GLTFMaterialsTransmissionExtension {

		constructor( writer ) {

			this.writer = writer;
			this.name = 'KHR_materials_transmission';

		}
		writeMaterial( material, materialDef ) {

			if ( ! material.isMeshPhysicalMaterial || material.transmission === 0 ) return;
			const writer = this.writer;
			const extensionsUsed = writer.extensionsUsed;
			const extensionDef = {};
			extensionDef.transmissionFactor = material.transmission;
			if ( material.transmissionMap ) {

				const transmissionMapDef = {
					index: writer.processTexture( material.transmissionMap )
				};
				writer.applyTextureTransform( transmissionMapDef, material.transmissionMap );
				extensionDef.transmissionTexture = transmissionMapDef;

			}

			materialDef.extensions = materialDef.extensions || {};
			materialDef.extensions[ this.name ] = extensionDef;
			extensionsUsed[ this.name ] = true;

		}

	}

	/**
 * Materials Volume Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_volume
 */
	class GLTFMaterialsVolumeExtension {

		constructor( writer ) {

			this.writer = writer;
			this.name = 'KHR_materials_volume';

		}
		writeMaterial( material, materialDef ) {

			if ( ! material.isMeshPhysicalMaterial || material.transmission === 0 ) return;
			const writer = this.writer;
			const extensionsUsed = writer.extensionsUsed;
			const extensionDef = {};
			extensionDef.thicknessFactor = material.thickness;
			if ( material.thicknessMap ) {

				const thicknessMapDef = {
					index: writer.processTexture( material.thicknessMap )
				};
				writer.applyTextureTransform( thicknessMapDef, material.thicknessMap );
				extensionDef.thicknessTexture = thicknessMapDef;

			}

			extensionDef.attenuationDistance = material.attenuationDistance;
			extensionDef.attenuationColor = material.attenuationColor.toArray();
			materialDef.extensions = materialDef.extensions || {};
			materialDef.extensions[ this.name ] = extensionDef;
			extensionsUsed[ this.name ] = true;

		}

	}

	/**
 * Static utility functions
 */
	GLTFExporter.Utils = {
		insertKeyframe: function ( track, time ) {

			const tolerance = 0.001; // 1ms
			const valueSize = track.getValueSize();
			const times = new track.TimeBufferType( track.times.length + 1 );
			const values = new track.ValueBufferType( track.values.length + valueSize );
			const interpolant = track.createInterpolant( new track.ValueBufferType( valueSize ) );
			let index;
			if ( track.times.length === 0 ) {

				times[ 0 ] = time;
				for ( let i = 0; i < valueSize; i ++ ) {

					values[ i ] = 0;

				}

				index = 0;

			} else if ( time < track.times[ 0 ] ) {

				if ( Math.abs( track.times[ 0 ] - time ) < tolerance ) return 0;
				times[ 0 ] = time;
				times.set( track.times, 1 );
				values.set( interpolant.evaluate( time ), 0 );
				values.set( track.values, valueSize );
				index = 0;

			} else if ( time > track.times[ track.times.length - 1 ] ) {

				if ( Math.abs( track.times[ track.times.length - 1 ] - time ) < tolerance ) {

					return track.times.length - 1;

				}

				times[ times.length - 1 ] = time;
				times.set( track.times, 0 );
				values.set( track.values, 0 );
				values.set( interpolant.evaluate( time ), track.values.length );
				index = times.length - 1;

			} else {

				for ( let i = 0; i < track.times.length; i ++ ) {

					if ( Math.abs( track.times[ i ] - time ) < tolerance ) return i;
					if ( track.times[ i ] < time && track.times[ i + 1 ] > time ) {

						times.set( track.times.slice( 0, i + 1 ), 0 );
						times[ i + 1 ] = time;
						times.set( track.times.slice( i + 1 ), i + 2 );
						values.set( track.values.slice( 0, ( i + 1 ) * valueSize ), 0 );
						values.set( interpolant.evaluate( time ), ( i + 1 ) * valueSize );
						values.set( track.values.slice( ( i + 1 ) * valueSize ), ( i + 2 ) * valueSize );
						index = i + 1;
						break;

					}

				}

			}

			track.times = times;
			track.values = values;
			return index;

		},
		mergeMorphTargetTracks: function ( clip, root ) {

			const tracks = [];
			const mergedTracks = {};
			const sourceTracks = clip.tracks;
			for ( let i = 0; i < sourceTracks.length; ++ i ) {

				let sourceTrack = sourceTracks[ i ];
				const sourceTrackBinding = THREE.PropertyBinding.parseTrackName( sourceTrack.name );
				const sourceTrackNode = THREE.PropertyBinding.findNode( root, sourceTrackBinding.nodeName );
				if ( sourceTrackBinding.propertyName !== 'morphTargetInfluences' || sourceTrackBinding.propertyIndex === undefined ) {

					// Tracks that don't affect morph targets, or that affect all morph targets together, can be left as-is.
					tracks.push( sourceTrack );
					continue;

				}

				if ( sourceTrack.createInterpolant !== sourceTrack.InterpolantFactoryMethodDiscrete && sourceTrack.createInterpolant !== sourceTrack.InterpolantFactoryMethodLinear ) {

					if ( sourceTrack.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline ) {

						// This should never happen, because glTF morph target animations
						// affect all targets already.
						throw new Error( 'THREE.GLTFExporter: Cannot merge tracks with glTF CUBICSPLINE interpolation.' );

					}

					console.warn( 'THREE.GLTFExporter: Morph target interpolation mode not yet supported. Using LINEAR instead.' );
					sourceTrack = sourceTrack.clone();
					sourceTrack.setInterpolation( THREE.InterpolateLinear );

				}

				const targetCount = sourceTrackNode.morphTargetInfluences.length;
				const targetIndex = sourceTrackNode.morphTargetDictionary[ sourceTrackBinding.propertyIndex ];
				if ( targetIndex === undefined ) {

					throw new Error( 'THREE.GLTFExporter: Morph target name not found: ' + sourceTrackBinding.propertyIndex );

				}

				let mergedTrack;

				// If this is the first time we've seen this object, create a new
				// track to store merged keyframe data for each morph target.
				if ( mergedTracks[ sourceTrackNode.uuid ] === undefined ) {

					mergedTrack = sourceTrack.clone();
					const values = new mergedTrack.ValueBufferType( targetCount * mergedTrack.times.length );
					for ( let j = 0; j < mergedTrack.times.length; j ++ ) {

						values[ j * targetCount + targetIndex ] = mergedTrack.values[ j ];

					}

					// We need to take into consideration the intended target node
					// of our original un-merged morphTarget animation.
					mergedTrack.name = ( sourceTrackBinding.nodeName || '' ) + '.morphTargetInfluences';
					mergedTrack.values = values;
					mergedTracks[ sourceTrackNode.uuid ] = mergedTrack;
					tracks.push( mergedTrack );
					continue;

				}

				const sourceInterpolant = sourceTrack.createInterpolant( new sourceTrack.ValueBufferType( 1 ) );
				mergedTrack = mergedTracks[ sourceTrackNode.uuid ];

				// For every existing keyframe of the merged track, write a (possibly
				// interpolated) value from the source track.
				for ( let j = 0; j < mergedTrack.times.length; j ++ ) {

					mergedTrack.values[ j * targetCount + targetIndex ] = sourceInterpolant.evaluate( mergedTrack.times[ j ] );

				}

				// For every existing keyframe of the source track, write a (possibly
				// new) keyframe to the merged track. Values from the previous loop may
				// be written again, but keyframes are de-duplicated.
				for ( let j = 0; j < sourceTrack.times.length; j ++ ) {

					const keyframeIndex = this.insertKeyframe( mergedTrack, sourceTrack.times[ j ] );
					mergedTrack.values[ keyframeIndex * targetCount + targetIndex ] = sourceTrack.values[ j ];

				}

			}

			clip.tracks = tracks;
			return clip;

		}
	};

	THREE.GLTFExporter = GLTFExporter;

} )();

// ---- loaders/STLLoader.js ----
( function () {

	/**
 * Description: A THREE loader for STL ASCII files, as created by Solidworks and other CAD programs.
 *
 * Supports both binary and ASCII encoded files, with automatic detection of type.
 *
 * The loader returns a non-indexed buffer geometry.
 *
 * Limitations:
 *  Binary decoding supports "Magics" color format (http://en.wikipedia.org/wiki/STL_(file_format)#Color_in_binary_STL).
 *  There is perhaps some question as to how valid it is to always assume little-endian-ness.
 *  ASCII decoding assumes file is UTF-8.
 *
 * Usage:
 *  const loader = new STLLoader();
 *  loader.load( './models/stl/slotted_disk.stl', function ( geometry ) {
 *    scene.add( new THREE.Mesh( geometry ) );
 *  });
 *
 * For binary STLs geometry might contain colors for vertices. To use it:
 *  // use the same code to load STL as above
 *  if (geometry.hasColors) {
 *    material = new THREE.MeshPhongMaterial({ opacity: geometry.alpha, vertexColors: true });
 *  } else { .... }
 *  const mesh = new THREE.Mesh( geometry, material );
 *
 * For ASCII STLs containing multiple solids, each solid is assigned to a different group.
 * Groups can be used to assign a different color by defining an array of materials with the same length of
 * geometry.groups and passing it to the Mesh constructor:
 *
 * const mesh = new THREE.Mesh( geometry, material );
 *
 * For example:
 *
 *  const materials = [];
 *  const nGeometryGroups = geometry.groups.length;
 *
 *  const colorMap = ...; // Some logic to index colors.
 *
 *  for (let i = 0; i < nGeometryGroups; i++) {
 *
 *		const material = new THREE.MeshPhongMaterial({
 *			color: colorMap[i],
 *			wireframe: false
 *		});
 *
 *  }
 *
 *  materials.push(material);
 *  const mesh = new THREE.Mesh(geometry, materials);
 */

	class STLLoader extends THREE.Loader {

		constructor( manager ) {

			super( manager );

		}
		load( url, onLoad, onProgress, onError ) {

			const scope = this;
			const loader = new THREE.FileLoader( this.manager );
			loader.setPath( this.path );
			loader.setResponseType( 'arraybuffer' );
			loader.setRequestHeader( this.requestHeader );
			loader.setWithCredentials( this.withCredentials );
			loader.load( url, function ( text ) {

				try {

					onLoad( scope.parse( text ) );

				} catch ( e ) {

					if ( onError ) {

						onError( e );

					} else {

						console.error( e );

					}

					scope.manager.itemError( url );

				}

			}, onProgress, onError );

		}
		parse( data ) {

			function isBinary( data ) {

				const reader = new DataView( data );
				const face_size = 32 / 8 * 3 + 32 / 8 * 3 * 3 + 16 / 8;
				const n_faces = reader.getUint32( 80, true );
				const expect = 80 + 32 / 8 + n_faces * face_size;
				if ( expect === reader.byteLength ) {

					return true;

				}

				// An ASCII STL data must begin with 'solid ' as the first six bytes.
				// However, ASCII STLs lacking the SPACE after the 'd' are known to be
				// plentiful.  So, check the first 5 bytes for 'solid'.

				// Several encodings, such as UTF-8, precede the text with up to 5 bytes:
				// https://en.wikipedia.org/wiki/Byte_order_mark#Byte_order_marks_by_encoding
				// Search for "solid" to start anywhere after those prefixes.

				// US-ASCII ordinal values for 's', 'o', 'l', 'i', 'd'

				const solid = [ 115, 111, 108, 105, 100 ];
				for ( let off = 0; off < 5; off ++ ) {

					// If "solid" text is matched to the current offset, declare it to be an ASCII STL.

					if ( matchDataViewAt( solid, reader, off ) ) return false;

				}

				// Couldn't find "solid" text at the beginning; it is binary STL.

				return true;

			}

			function matchDataViewAt( query, reader, offset ) {

				// Check if each byte in query matches the corresponding byte from the current offset

				for ( let i = 0, il = query.length; i < il; i ++ ) {

					if ( query[ i ] !== reader.getUint8( offset + i ) ) return false;

				}

				return true;

			}

			function parseBinary( data ) {

				const reader = new DataView( data );
				const faces = reader.getUint32( 80, true );
				let r,
					g,
					b,
					hasColors = false,
					colors;
				let defaultR, defaultG, defaultB, alpha;

				// process STL header
				// check for default color in header ("COLOR=rgba" sequence).

				for ( let index = 0; index < 80 - 10; index ++ ) {

					if ( reader.getUint32( index, false ) == 0x434F4C4F /*COLO*/ && reader.getUint8( index + 4 ) == 0x52 /*'R'*/ && reader.getUint8( index + 5 ) == 0x3D /*'='*/ ) {

						hasColors = true;
						colors = new Float32Array( faces * 3 * 3 );
						defaultR = reader.getUint8( index + 6 ) / 255;
						defaultG = reader.getUint8( index + 7 ) / 255;
						defaultB = reader.getUint8( index + 8 ) / 255;
						alpha = reader.getUint8( index + 9 ) / 255;

					}

				}

				const dataOffset = 84;
				const faceLength = 12 * 4 + 2;
				const geometry = new THREE.BufferGeometry();
				const vertices = new Float32Array( faces * 3 * 3 );
				const normals = new Float32Array( faces * 3 * 3 );
				for ( let face = 0; face < faces; face ++ ) {

					const start = dataOffset + face * faceLength;
					const normalX = reader.getFloat32( start, true );
					const normalY = reader.getFloat32( start + 4, true );
					const normalZ = reader.getFloat32( start + 8, true );
					if ( hasColors ) {

						const packedColor = reader.getUint16( start + 48, true );
						if ( ( packedColor & 0x8000 ) === 0 ) {

							// facet has its own unique color

							r = ( packedColor & 0x1F ) / 31;
							g = ( packedColor >> 5 & 0x1F ) / 31;
							b = ( packedColor >> 10 & 0x1F ) / 31;

						} else {

							r = defaultR;
							g = defaultG;
							b = defaultB;

						}

					}

					for ( let i = 1; i <= 3; i ++ ) {

						const vertexstart = start + i * 12;
						const componentIdx = face * 3 * 3 + ( i - 1 ) * 3;
						vertices[ componentIdx ] = reader.getFloat32( vertexstart, true );
						vertices[ componentIdx + 1 ] = reader.getFloat32( vertexstart + 4, true );
						vertices[ componentIdx + 2 ] = reader.getFloat32( vertexstart + 8, true );
						normals[ componentIdx ] = normalX;
						normals[ componentIdx + 1 ] = normalY;
						normals[ componentIdx + 2 ] = normalZ;
						if ( hasColors ) {

							colors[ componentIdx ] = r;
							colors[ componentIdx + 1 ] = g;
							colors[ componentIdx + 2 ] = b;

						}

					}

				}

				geometry.setAttribute( 'position', new THREE.BufferAttribute( vertices, 3 ) );
				geometry.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
				if ( hasColors ) {

					geometry.setAttribute( 'color', new THREE.BufferAttribute( colors, 3 ) );
					geometry.hasColors = true;
					geometry.alpha = alpha;

				}

				return geometry;

			}

			function parseASCII( data ) {

				const geometry = new THREE.BufferGeometry();
				const patternSolid = /solid([\s\S]*?)endsolid/g;
				const patternFace = /facet([\s\S]*?)endfacet/g;
				let faceCounter = 0;
				const patternFloat = /[\s]+([+-]?(?:\d*)(?:\.\d*)?(?:[eE][+-]?\d+)?)/.source;
				const patternVertex = new RegExp( 'vertex' + patternFloat + patternFloat + patternFloat, 'g' );
				const patternNormal = new RegExp( 'normal' + patternFloat + patternFloat + patternFloat, 'g' );
				const vertices = [];
				const normals = [];
				const normal = new THREE.Vector3();
				let result;
				let groupCount = 0;
				let startVertex = 0;
				let endVertex = 0;
				while ( ( result = patternSolid.exec( data ) ) !== null ) {

					startVertex = endVertex;
					const solid = result[ 0 ];
					while ( ( result = patternFace.exec( solid ) ) !== null ) {

						let vertexCountPerFace = 0;
						let normalCountPerFace = 0;
						const text = result[ 0 ];
						while ( ( result = patternNormal.exec( text ) ) !== null ) {

							normal.x = parseFloat( result[ 1 ] );
							normal.y = parseFloat( result[ 2 ] );
							normal.z = parseFloat( result[ 3 ] );
							normalCountPerFace ++;

						}

						while ( ( result = patternVertex.exec( text ) ) !== null ) {

							vertices.push( parseFloat( result[ 1 ] ), parseFloat( result[ 2 ] ), parseFloat( result[ 3 ] ) );
							normals.push( normal.x, normal.y, normal.z );
							vertexCountPerFace ++;
							endVertex ++;

						}

						// every face have to own ONE valid normal

						if ( normalCountPerFace !== 1 ) {

							console.error( 'THREE.STLLoader: Something isn\'t right with the normal of face number ' + faceCounter );

						}

						// each face have to own THREE valid vertices

						if ( vertexCountPerFace !== 3 ) {

							console.error( 'THREE.STLLoader: Something isn\'t right with the vertices of face number ' + faceCounter );

						}

						faceCounter ++;

					}

					const start = startVertex;
					const count = endVertex - startVertex;
					geometry.addGroup( start, count, groupCount );
					groupCount ++;

				}

				geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( vertices, 3 ) );
				geometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( normals, 3 ) );
				return geometry;

			}

			function ensureString( buffer ) {

				if ( typeof buffer !== 'string' ) {

					return THREE.LoaderUtils.decodeText( new Uint8Array( buffer ) );

				}

				return buffer;

			}

			function ensureBinary( buffer ) {

				if ( typeof buffer === 'string' ) {

					const array_buffer = new Uint8Array( buffer.length );
					for ( let i = 0; i < buffer.length; i ++ ) {

						array_buffer[ i ] = buffer.charCodeAt( i ) & 0xff; // implicitly assumes little-endian

					}

					return array_buffer.buffer || array_buffer;

				} else {

					return buffer;

				}

			}

			// start

			const binData = ensureBinary( data );
			return isBinary( binData ) ? parseBinary( binData ) : parseASCII( ensureString( data ) );

		}

	}

	THREE.STLLoader = STLLoader;

} )();

// ---- loaders/OBJLoader.js ----
( function () {

	// o object_name | g group_name
	const _object_pattern = /^[og]\s*(.+)?/;
	// mtllib file_reference
	const _material_library_pattern = /^mtllib /;
	// usemtl material_name
	const _material_use_pattern = /^usemtl /;
	// usemap map_name
	const _map_use_pattern = /^usemap /;
	const _face_vertex_data_separator_pattern = /\s+/;
	const _vA = new THREE.Vector3();
	const _vB = new THREE.Vector3();
	const _vC = new THREE.Vector3();
	const _ab = new THREE.Vector3();
	const _cb = new THREE.Vector3();
	const _color = new THREE.Color();
	function ParserState() {

		const state = {
			objects: [],
			object: {},
			vertices: [],
			normals: [],
			colors: [],
			uvs: [],
			materials: {},
			materialLibraries: [],
			startObject: function ( name, fromDeclaration ) {

				// If the current object (initial from reset) is not from a g/o declaration in the parsed
				// file. We need to use it for the first parsed g/o to keep things in sync.
				if ( this.object && this.object.fromDeclaration === false ) {

					this.object.name = name;
					this.object.fromDeclaration = fromDeclaration !== false;
					return;

				}

				const previousMaterial = this.object && typeof this.object.currentMaterial === 'function' ? this.object.currentMaterial() : undefined;
				if ( this.object && typeof this.object._finalize === 'function' ) {

					this.object._finalize( true );

				}

				this.object = {
					name: name || '',
					fromDeclaration: fromDeclaration !== false,
					geometry: {
						vertices: [],
						normals: [],
						colors: [],
						uvs: [],
						hasUVIndices: false
					},
					materials: [],
					smooth: true,
					startMaterial: function ( name, libraries ) {

						const previous = this._finalize( false );

						// New usemtl declaration overwrites an inherited material, except if faces were declared
						// after the material, then it must be preserved for proper MultiMaterial continuation.
						if ( previous && ( previous.inherited || previous.groupCount <= 0 ) ) {

							this.materials.splice( previous.index, 1 );

						}

						const material = {
							index: this.materials.length,
							name: name || '',
							mtllib: Array.isArray( libraries ) && libraries.length > 0 ? libraries[ libraries.length - 1 ] : '',
							smooth: previous !== undefined ? previous.smooth : this.smooth,
							groupStart: previous !== undefined ? previous.groupEnd : 0,
							groupEnd: - 1,
							groupCount: - 1,
							inherited: false,
							clone: function ( index ) {

								const cloned = {
									index: typeof index === 'number' ? index : this.index,
									name: this.name,
									mtllib: this.mtllib,
									smooth: this.smooth,
									groupStart: 0,
									groupEnd: - 1,
									groupCount: - 1,
									inherited: false
								};
								cloned.clone = this.clone.bind( cloned );
								return cloned;

							}
						};
						this.materials.push( material );
						return material;

					},
					currentMaterial: function () {

						if ( this.materials.length > 0 ) {

							return this.materials[ this.materials.length - 1 ];

						}

						return undefined;

					},
					_finalize: function ( end ) {

						const lastMultiMaterial = this.currentMaterial();
						if ( lastMultiMaterial && lastMultiMaterial.groupEnd === - 1 ) {

							lastMultiMaterial.groupEnd = this.geometry.vertices.length / 3;
							lastMultiMaterial.groupCount = lastMultiMaterial.groupEnd - lastMultiMaterial.groupStart;
							lastMultiMaterial.inherited = false;

						}

						// Ignore objects tail materials if no face declarations followed them before a new o/g started.
						if ( end && this.materials.length > 1 ) {

							for ( let mi = this.materials.length - 1; mi >= 0; mi -- ) {

								if ( this.materials[ mi ].groupCount <= 0 ) {

									this.materials.splice( mi, 1 );

								}

							}

						}

						// Guarantee at least one empty material, this makes the creation later more straight forward.
						if ( end && this.materials.length === 0 ) {

							this.materials.push( {
								name: '',
								smooth: this.smooth
							} );

						}

						return lastMultiMaterial;

					}
				};

				// Inherit previous objects material.
				// Spec tells us that a declared material must be set to all objects until a new material is declared.
				// If a usemtl declaration is encountered while this new object is being parsed, it will
				// overwrite the inherited material. Exception being that there was already face declarations
				// to the inherited material, then it will be preserved for proper MultiMaterial continuation.

				if ( previousMaterial && previousMaterial.name && typeof previousMaterial.clone === 'function' ) {

					const declared = previousMaterial.clone( 0 );
					declared.inherited = true;
					this.object.materials.push( declared );

				}

				this.objects.push( this.object );

			},
			finalize: function () {

				if ( this.object && typeof this.object._finalize === 'function' ) {

					this.object._finalize( true );

				}

			},
			parseVertexIndex: function ( value, len ) {

				const index = parseInt( value, 10 );
				return ( index >= 0 ? index - 1 : index + len / 3 ) * 3;

			},
			parseNormalIndex: function ( value, len ) {

				const index = parseInt( value, 10 );
				return ( index >= 0 ? index - 1 : index + len / 3 ) * 3;

			},
			parseUVIndex: function ( value, len ) {

				const index = parseInt( value, 10 );
				return ( index >= 0 ? index - 1 : index + len / 2 ) * 2;

			},
			addVertex: function ( a, b, c ) {

				const src = this.vertices;
				const dst = this.object.geometry.vertices;
				dst.push( src[ a + 0 ], src[ a + 1 ], src[ a + 2 ] );
				dst.push( src[ b + 0 ], src[ b + 1 ], src[ b + 2 ] );
				dst.push( src[ c + 0 ], src[ c + 1 ], src[ c + 2 ] );

			},
			addVertexPoint: function ( a ) {

				const src = this.vertices;
				const dst = this.object.geometry.vertices;
				dst.push( src[ a + 0 ], src[ a + 1 ], src[ a + 2 ] );

			},
			addVertexLine: function ( a ) {

				const src = this.vertices;
				const dst = this.object.geometry.vertices;
				dst.push( src[ a + 0 ], src[ a + 1 ], src[ a + 2 ] );

			},
			addNormal: function ( a, b, c ) {

				const src = this.normals;
				const dst = this.object.geometry.normals;
				dst.push( src[ a + 0 ], src[ a + 1 ], src[ a + 2 ] );
				dst.push( src[ b + 0 ], src[ b + 1 ], src[ b + 2 ] );
				dst.push( src[ c + 0 ], src[ c + 1 ], src[ c + 2 ] );

			},
			addFaceNormal: function ( a, b, c ) {

				const src = this.vertices;
				const dst = this.object.geometry.normals;
				_vA.fromArray( src, a );
				_vB.fromArray( src, b );
				_vC.fromArray( src, c );
				_cb.subVectors( _vC, _vB );
				_ab.subVectors( _vA, _vB );
				_cb.cross( _ab );
				_cb.normalize();
				dst.push( _cb.x, _cb.y, _cb.z );
				dst.push( _cb.x, _cb.y, _cb.z );
				dst.push( _cb.x, _cb.y, _cb.z );

			},
			addColor: function ( a, b, c ) {

				const src = this.colors;
				const dst = this.object.geometry.colors;
				if ( src[ a ] !== undefined ) dst.push( src[ a + 0 ], src[ a + 1 ], src[ a + 2 ] );
				if ( src[ b ] !== undefined ) dst.push( src[ b + 0 ], src[ b + 1 ], src[ b + 2 ] );
				if ( src[ c ] !== undefined ) dst.push( src[ c + 0 ], src[ c + 1 ], src[ c + 2 ] );

			},
			addUV: function ( a, b, c ) {

				const src = this.uvs;
				const dst = this.object.geometry.uvs;
				dst.push( src[ a + 0 ], src[ a + 1 ] );
				dst.push( src[ b + 0 ], src[ b + 1 ] );
				dst.push( src[ c + 0 ], src[ c + 1 ] );

			},
			addDefaultUV: function () {

				const dst = this.object.geometry.uvs;
				dst.push( 0, 0 );
				dst.push( 0, 0 );
				dst.push( 0, 0 );

			},
			addUVLine: function ( a ) {

				const src = this.uvs;
				const dst = this.object.geometry.uvs;
				dst.push( src[ a + 0 ], src[ a + 1 ] );

			},
			addFace: function ( a, b, c, ua, ub, uc, na, nb, nc ) {

				const vLen = this.vertices.length;
				let ia = this.parseVertexIndex( a, vLen );
				let ib = this.parseVertexIndex( b, vLen );
				let ic = this.parseVertexIndex( c, vLen );
				this.addVertex( ia, ib, ic );
				this.addColor( ia, ib, ic );

				// normals

				if ( na !== undefined && na !== '' ) {

					const nLen = this.normals.length;
					ia = this.parseNormalIndex( na, nLen );
					ib = this.parseNormalIndex( nb, nLen );
					ic = this.parseNormalIndex( nc, nLen );
					this.addNormal( ia, ib, ic );

				} else {

					this.addFaceNormal( ia, ib, ic );

				}

				// uvs

				if ( ua !== undefined && ua !== '' ) {

					const uvLen = this.uvs.length;
					ia = this.parseUVIndex( ua, uvLen );
					ib = this.parseUVIndex( ub, uvLen );
					ic = this.parseUVIndex( uc, uvLen );
					this.addUV( ia, ib, ic );
					this.object.geometry.hasUVIndices = true;

				} else {

					// add placeholder values (for inconsistent face definitions)

					this.addDefaultUV();

				}

			},
			addPointGeometry: function ( vertices ) {

				this.object.geometry.type = 'Points';
				const vLen = this.vertices.length;
				for ( let vi = 0, l = vertices.length; vi < l; vi ++ ) {

					const index = this.parseVertexIndex( vertices[ vi ], vLen );
					this.addVertexPoint( index );
					this.addColor( index );

				}

			},
			addLineGeometry: function ( vertices, uvs ) {

				this.object.geometry.type = 'Line';
				const vLen = this.vertices.length;
				const uvLen = this.uvs.length;
				for ( let vi = 0, l = vertices.length; vi < l; vi ++ ) {

					this.addVertexLine( this.parseVertexIndex( vertices[ vi ], vLen ) );

				}

				for ( let uvi = 0, l = uvs.length; uvi < l; uvi ++ ) {

					this.addUVLine( this.parseUVIndex( uvs[ uvi ], uvLen ) );

				}

			}
		};
		state.startObject( '', false );
		return state;

	}

	//

	class OBJLoader extends THREE.Loader {

		constructor( manager ) {

			super( manager );
			this.materials = null;

		}
		load( url, onLoad, onProgress, onError ) {

			const scope = this;
			const loader = new THREE.FileLoader( this.manager );
			loader.setPath( this.path );
			loader.setRequestHeader( this.requestHeader );
			loader.setWithCredentials( this.withCredentials );
			loader.load( url, function ( text ) {

				try {

					onLoad( scope.parse( text ) );

				} catch ( e ) {

					if ( onError ) {

						onError( e );

					} else {

						console.error( e );

					}

					scope.manager.itemError( url );

				}

			}, onProgress, onError );

		}
		setMaterials( materials ) {

			this.materials = materials;
			return this;

		}
		parse( text ) {

			const state = new ParserState();
			if ( text.indexOf( '\r\n' ) !== - 1 ) {

				// This is faster than String.split with regex that splits on both
				text = text.replace( /\r\n/g, '\n' );

			}

			if ( text.indexOf( '\\\n' ) !== - 1 ) {

				// join lines separated by a line continuation character (\)
				text = text.replace( /\\\n/g, '' );

			}

			const lines = text.split( '\n' );
			let result = [];
			for ( let i = 0, l = lines.length; i < l; i ++ ) {

				const line = lines[ i ].trimStart();
				if ( line.length === 0 ) continue;
				const lineFirstChar = line.charAt( 0 );

				// @todo invoke passed in handler if any
				if ( lineFirstChar === '#' ) continue;
				if ( lineFirstChar === 'v' ) {

					const data = line.split( _face_vertex_data_separator_pattern );
					switch ( data[ 0 ] ) {

						case 'v':
							state.vertices.push( parseFloat( data[ 1 ] ), parseFloat( data[ 2 ] ), parseFloat( data[ 3 ] ) );
							if ( data.length >= 7 ) {

								_color.setRGB( parseFloat( data[ 4 ] ), parseFloat( data[ 5 ] ), parseFloat( data[ 6 ] ) ).convertSRGBToLinear();
								state.colors.push( _color.r, _color.g, _color.b );

							} else {

								// if no colors are defined, add placeholders so color and vertex indices match

								state.colors.push( undefined, undefined, undefined );

							}

							break;
						case 'vn':
							state.normals.push( parseFloat( data[ 1 ] ), parseFloat( data[ 2 ] ), parseFloat( data[ 3 ] ) );
							break;
						case 'vt':
							state.uvs.push( parseFloat( data[ 1 ] ), parseFloat( data[ 2 ] ) );
							break;

					}

				} else if ( lineFirstChar === 'f' ) {

					const lineData = line.slice( 1 ).trim();
					const vertexData = lineData.split( _face_vertex_data_separator_pattern );
					const faceVertices = [];

					// Parse the face vertex data into an easy to work with format

					for ( let j = 0, jl = vertexData.length; j < jl; j ++ ) {

						const vertex = vertexData[ j ];
						if ( vertex.length > 0 ) {

							const vertexParts = vertex.split( '/' );
							faceVertices.push( vertexParts );

						}

					}

					// Draw an edge between the first vertex and all subsequent vertices to form an n-gon

					const v1 = faceVertices[ 0 ];
					for ( let j = 1, jl = faceVertices.length - 1; j < jl; j ++ ) {

						const v2 = faceVertices[ j ];
						const v3 = faceVertices[ j + 1 ];
						state.addFace( v1[ 0 ], v2[ 0 ], v3[ 0 ], v1[ 1 ], v2[ 1 ], v3[ 1 ], v1[ 2 ], v2[ 2 ], v3[ 2 ] );

					}

				} else if ( lineFirstChar === 'l' ) {

					const lineParts = line.substring( 1 ).trim().split( ' ' );
					let lineVertices = [];
					const lineUVs = [];
					if ( line.indexOf( '/' ) === - 1 ) {

						lineVertices = lineParts;

					} else {

						for ( let li = 0, llen = lineParts.length; li < llen; li ++ ) {

							const parts = lineParts[ li ].split( '/' );
							if ( parts[ 0 ] !== '' ) lineVertices.push( parts[ 0 ] );
							if ( parts[ 1 ] !== '' ) lineUVs.push( parts[ 1 ] );

						}

					}

					state.addLineGeometry( lineVertices, lineUVs );

				} else if ( lineFirstChar === 'p' ) {

					const lineData = line.slice( 1 ).trim();
					const pointData = lineData.split( ' ' );
					state.addPointGeometry( pointData );

				} else if ( ( result = _object_pattern.exec( line ) ) !== null ) {

					// o object_name
					// or
					// g group_name

					// WORKAROUND: https://bugs.chromium.org/p/v8/issues/detail?id=2869
					// let name = result[ 0 ].slice( 1 ).trim();
					const name = ( ' ' + result[ 0 ].slice( 1 ).trim() ).slice( 1 );
					state.startObject( name );

				} else if ( _material_use_pattern.test( line ) ) {

					// material

					state.object.startMaterial( line.substring( 7 ).trim(), state.materialLibraries );

				} else if ( _material_library_pattern.test( line ) ) {

					// mtl file

					state.materialLibraries.push( line.substring( 7 ).trim() );

				} else if ( _map_use_pattern.test( line ) ) {

					// the line is parsed but ignored since the loader assumes textures are defined MTL files
					// (according to https://www.okino.com/conv/imp_wave.htm, 'usemap' is the old-style Wavefront texture reference method)

					console.warn( 'THREE.OBJLoader: Rendering identifier "usemap" not supported. Textures must be defined in MTL files.' );

				} else if ( lineFirstChar === 's' ) {

					result = line.split( ' ' );

					// smooth shading

					// @todo Handle files that have varying smooth values for a set of faces inside one geometry,
					// but does not define a usemtl for each face set.
					// This should be detected and a dummy material created (later MultiMaterial and geometry groups).
					// This requires some care to not create extra material on each smooth value for "normal" obj files.
					// where explicit usemtl defines geometry groups.
					// Example asset: examples/models/obj/cerberus/Cerberus.obj

					/*
        	 * http://paulbourke.net/dataformats/obj/
        	 *
        	 * From chapter "Grouping" Syntax explanation "s group_number":
        	 * "group_number is the smoothing group number. To turn off smoothing groups, use a value of 0 or off.
        	 * Polygonal elements use group numbers to put elements in different smoothing groups. For free-form
        	 * surfaces, smoothing groups are either turned on or off; there is no difference between values greater
        	 * than 0."
        	 */
					if ( result.length > 1 ) {

						const value = result[ 1 ].trim().toLowerCase();
						state.object.smooth = value !== '0' && value !== 'off';

					} else {

						// ZBrush can produce "s" lines #11707
						state.object.smooth = true;

					}

					const material = state.object.currentMaterial();
					if ( material ) material.smooth = state.object.smooth;

				} else {

					// Handle null terminated files without exception
					if ( line === '\0' ) continue;
					console.warn( 'THREE.OBJLoader: Unexpected line: "' + line + '"' );

				}

			}

			state.finalize();
			const container = new THREE.Group();
			container.materialLibraries = [].concat( state.materialLibraries );
			const hasPrimitives = ! ( state.objects.length === 1 && state.objects[ 0 ].geometry.vertices.length === 0 );
			if ( hasPrimitives === true ) {

				for ( let i = 0, l = state.objects.length; i < l; i ++ ) {

					const object = state.objects[ i ];
					const geometry = object.geometry;
					const materials = object.materials;
					const isLine = geometry.type === 'Line';
					const isPoints = geometry.type === 'Points';
					let hasVertexColors = false;

					// Skip o/g line declarations that did not follow with any faces
					if ( geometry.vertices.length === 0 ) continue;
					const buffergeometry = new THREE.BufferGeometry();
					buffergeometry.setAttribute( 'position', new THREE.Float32BufferAttribute( geometry.vertices, 3 ) );
					if ( geometry.normals.length > 0 ) {

						buffergeometry.setAttribute( 'normal', new THREE.Float32BufferAttribute( geometry.normals, 3 ) );

					}

					if ( geometry.colors.length > 0 ) {

						hasVertexColors = true;
						buffergeometry.setAttribute( 'color', new THREE.Float32BufferAttribute( geometry.colors, 3 ) );

					}

					if ( geometry.hasUVIndices === true ) {

						buffergeometry.setAttribute( 'uv', new THREE.Float32BufferAttribute( geometry.uvs, 2 ) );

					}

					// Create materials

					const createdMaterials = [];
					for ( let mi = 0, miLen = materials.length; mi < miLen; mi ++ ) {

						const sourceMaterial = materials[ mi ];
						const materialHash = sourceMaterial.name + '_' + sourceMaterial.smooth + '_' + hasVertexColors;
						let material = state.materials[ materialHash ];
						if ( this.materials !== null ) {

							material = this.materials.create( sourceMaterial.name );

							// mtl etc. loaders probably can't create line materials correctly, copy properties to a line material.
							if ( isLine && material && ! ( material instanceof THREE.LineBasicMaterial ) ) {

								const materialLine = new THREE.LineBasicMaterial();
								THREE.Material.prototype.copy.call( materialLine, material );
								materialLine.color.copy( material.color );
								material = materialLine;

							} else if ( isPoints && material && ! ( material instanceof THREE.PointsMaterial ) ) {

								const materialPoints = new THREE.PointsMaterial( {
									size: 10,
									sizeAttenuation: false
								} );
								THREE.Material.prototype.copy.call( materialPoints, material );
								materialPoints.color.copy( material.color );
								materialPoints.map = material.map;
								material = materialPoints;

							}

						}

						if ( material === undefined ) {

							if ( isLine ) {

								material = new THREE.LineBasicMaterial();

							} else if ( isPoints ) {

								material = new THREE.PointsMaterial( {
									size: 1,
									sizeAttenuation: false
								} );

							} else {

								material = new THREE.MeshPhongMaterial();

							}

							material.name = sourceMaterial.name;
							material.flatShading = sourceMaterial.smooth ? false : true;
							material.vertexColors = hasVertexColors;
							state.materials[ materialHash ] = material;

						}

						createdMaterials.push( material );

					}

					// Create mesh

					let mesh;
					if ( createdMaterials.length > 1 ) {

						for ( let mi = 0, miLen = materials.length; mi < miLen; mi ++ ) {

							const sourceMaterial = materials[ mi ];
							buffergeometry.addGroup( sourceMaterial.groupStart, sourceMaterial.groupCount, mi );

						}

						if ( isLine ) {

							mesh = new THREE.LineSegments( buffergeometry, createdMaterials );

						} else if ( isPoints ) {

							mesh = new THREE.Points( buffergeometry, createdMaterials );

						} else {

							mesh = new THREE.Mesh( buffergeometry, createdMaterials );

						}

					} else {

						if ( isLine ) {

							mesh = new THREE.LineSegments( buffergeometry, createdMaterials[ 0 ] );

						} else if ( isPoints ) {

							mesh = new THREE.Points( buffergeometry, createdMaterials[ 0 ] );

						} else {

							mesh = new THREE.Mesh( buffergeometry, createdMaterials[ 0 ] );

						}

					}

					mesh.name = object.name;
					container.add( mesh );

				}

			} else {

				// if there is only the default parser state object with no geometry data, interpret data as point cloud

				if ( state.vertices.length > 0 ) {

					const material = new THREE.PointsMaterial( {
						size: 1,
						sizeAttenuation: false
					} );
					const buffergeometry = new THREE.BufferGeometry();
					buffergeometry.setAttribute( 'position', new THREE.Float32BufferAttribute( state.vertices, 3 ) );
					if ( state.colors.length > 0 && state.colors[ 0 ] !== undefined ) {

						buffergeometry.setAttribute( 'color', new THREE.Float32BufferAttribute( state.colors, 3 ) );
						material.vertexColors = true;

					}

					const points = new THREE.Points( buffergeometry, material );
					container.add( points );

				}

			}

			return container;

		}

	}

	THREE.OBJLoader = OBJLoader;

} )();

// ---- loaders/GLTFLoader.js ----
( function () {

	class GLTFLoader extends THREE.Loader {

		constructor( manager ) {

			super( manager );
			this.dracoLoader = null;
			this.ktx2Loader = null;
			this.meshoptDecoder = null;
			this.pluginCallbacks = [];
			this.register( function ( parser ) {

				return new GLTFMaterialsClearcoatExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFTextureBasisUExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFTextureWebPExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFMaterialsSheenExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFMaterialsTransmissionExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFMaterialsVolumeExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFMaterialsIorExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFMaterialsEmissiveStrengthExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFMaterialsSpecularExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFMaterialsIridescenceExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFLightsExtension( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFMeshoptCompression( parser );

			} );
			this.register( function ( parser ) {

				return new GLTFMeshGpuInstancing( parser );

			} );

		}
		load( url, onLoad, onProgress, onError ) {

			const scope = this;
			let resourcePath;
			if ( this.resourcePath !== '' ) {

				resourcePath = this.resourcePath;

			} else if ( this.path !== '' ) {

				resourcePath = this.path;

			} else {

				resourcePath = THREE.LoaderUtils.extractUrlBase( url );

			}

			// Tells the LoadingManager to track an extra item, which resolves after
			// the model is fully loaded. This means the count of items loaded will
			// be incorrect, but ensures manager.onLoad() does not fire early.
			this.manager.itemStart( url );
			const _onError = function ( e ) {

				if ( onError ) {

					onError( e );

				} else {

					console.error( e );

				}

				scope.manager.itemError( url );
				scope.manager.itemEnd( url );

			};

			const loader = new THREE.FileLoader( this.manager );
			loader.setPath( this.path );
			loader.setResponseType( 'arraybuffer' );
			loader.setRequestHeader( this.requestHeader );
			loader.setWithCredentials( this.withCredentials );
			loader.load( url, function ( data ) {

				try {

					scope.parse( data, resourcePath, function ( gltf ) {

						onLoad( gltf );
						scope.manager.itemEnd( url );

					}, _onError );

				} catch ( e ) {

					_onError( e );

				}

			}, onProgress, _onError );

		}
		setDRACOLoader( dracoLoader ) {

			this.dracoLoader = dracoLoader;
			return this;

		}
		setDDSLoader() {

			throw new Error( 'THREE.GLTFLoader: "MSFT_texture_dds" no longer supported. Please update to "KHR_texture_basisu".' );

		}
		setKTX2Loader( ktx2Loader ) {

			this.ktx2Loader = ktx2Loader;
			return this;

		}
		setMeshoptDecoder( meshoptDecoder ) {

			this.meshoptDecoder = meshoptDecoder;
			return this;

		}
		register( callback ) {

			if ( this.pluginCallbacks.indexOf( callback ) === - 1 ) {

				this.pluginCallbacks.push( callback );

			}

			return this;

		}
		unregister( callback ) {

			if ( this.pluginCallbacks.indexOf( callback ) !== - 1 ) {

				this.pluginCallbacks.splice( this.pluginCallbacks.indexOf( callback ), 1 );

			}

			return this;

		}
		parse( data, path, onLoad, onError ) {

			let json;
			const extensions = {};
			const plugins = {};
			if ( typeof data === 'string' ) {

				json = JSON.parse( data );

			} else if ( data instanceof ArrayBuffer ) {

				const magic = THREE.LoaderUtils.decodeText( new Uint8Array( data, 0, 4 ) );
				if ( magic === BINARY_EXTENSION_HEADER_MAGIC ) {

					try {

						extensions[ EXTENSIONS.KHR_BINARY_GLTF ] = new GLTFBinaryExtension( data );

					} catch ( error ) {

						if ( onError ) onError( error );
						return;

					}

					json = JSON.parse( extensions[ EXTENSIONS.KHR_BINARY_GLTF ].content );

				} else {

					json = JSON.parse( THREE.LoaderUtils.decodeText( new Uint8Array( data ) ) );

				}

			} else {

				json = data;

			}

			if ( json.asset === undefined || json.asset.version[ 0 ] < 2 ) {

				if ( onError ) onError( new Error( 'THREE.GLTFLoader: Unsupported asset. glTF versions >=2.0 are supported.' ) );
				return;

			}

			const parser = new GLTFParser( json, {
				path: path || this.resourcePath || '',
				crossOrigin: this.crossOrigin,
				requestHeader: this.requestHeader,
				manager: this.manager,
				ktx2Loader: this.ktx2Loader,
				meshoptDecoder: this.meshoptDecoder
			} );
			parser.fileLoader.setRequestHeader( this.requestHeader );
			for ( let i = 0; i < this.pluginCallbacks.length; i ++ ) {

				const plugin = this.pluginCallbacks[ i ]( parser );
				plugins[ plugin.name ] = plugin;

				// Workaround to avoid determining as unknown extension
				// in addUnknownExtensionsToUserData().
				// Remove this workaround if we move all the existing
				// extension handlers to plugin system
				extensions[ plugin.name ] = true;

			}

			if ( json.extensionsUsed ) {

				for ( let i = 0; i < json.extensionsUsed.length; ++ i ) {

					const extensionName = json.extensionsUsed[ i ];
					const extensionsRequired = json.extensionsRequired || [];
					switch ( extensionName ) {

						case EXTENSIONS.KHR_MATERIALS_UNLIT:
							extensions[ extensionName ] = new GLTFMaterialsUnlitExtension();
							break;
						case EXTENSIONS.KHR_DRACO_MESH_COMPRESSION:
							extensions[ extensionName ] = new GLTFDracoMeshCompressionExtension( json, this.dracoLoader );
							break;
						case EXTENSIONS.KHR_TEXTURE_TRANSFORM:
							extensions[ extensionName ] = new GLTFTextureTransformExtension();
							break;
						case EXTENSIONS.KHR_MESH_QUANTIZATION:
							extensions[ extensionName ] = new GLTFMeshQuantizationExtension();
							break;
						default:
							if ( extensionsRequired.indexOf( extensionName ) >= 0 && plugins[ extensionName ] === undefined ) {

								console.warn( 'THREE.GLTFLoader: Unknown extension "' + extensionName + '".' );

							}

					}

				}

			}

			parser.setExtensions( extensions );
			parser.setPlugins( plugins );
			parser.parse( onLoad, onError );

		}
		parseAsync( data, path ) {

			const scope = this;
			return new Promise( function ( resolve, reject ) {

				scope.parse( data, path, resolve, reject );

			} );

		}

	}

	/* GLTFREGISTRY */

	function GLTFRegistry() {

		let objects = {};
		return {
			get: function ( key ) {

				return objects[ key ];

			},
			add: function ( key, object ) {

				objects[ key ] = object;

			},
			remove: function ( key ) {

				delete objects[ key ];

			},
			removeAll: function () {

				objects = {};

			}
		};

	}

	/*********************************/
	/********** EXTENSIONS ***********/
	/*********************************/

	const EXTENSIONS = {
		KHR_BINARY_GLTF: 'KHR_binary_glTF',
		KHR_DRACO_MESH_COMPRESSION: 'KHR_draco_mesh_compression',
		KHR_LIGHTS_PUNCTUAL: 'KHR_lights_punctual',
		KHR_MATERIALS_CLEARCOAT: 'KHR_materials_clearcoat',
		KHR_MATERIALS_IOR: 'KHR_materials_ior',
		KHR_MATERIALS_SHEEN: 'KHR_materials_sheen',
		KHR_MATERIALS_SPECULAR: 'KHR_materials_specular',
		KHR_MATERIALS_TRANSMISSION: 'KHR_materials_transmission',
		KHR_MATERIALS_IRIDESCENCE: 'KHR_materials_iridescence',
		KHR_MATERIALS_UNLIT: 'KHR_materials_unlit',
		KHR_MATERIALS_VOLUME: 'KHR_materials_volume',
		KHR_TEXTURE_BASISU: 'KHR_texture_basisu',
		KHR_TEXTURE_TRANSFORM: 'KHR_texture_transform',
		KHR_MESH_QUANTIZATION: 'KHR_mesh_quantization',
		KHR_MATERIALS_EMISSIVE_STRENGTH: 'KHR_materials_emissive_strength',
		EXT_TEXTURE_WEBP: 'EXT_texture_webp',
		EXT_MESHOPT_COMPRESSION: 'EXT_meshopt_compression',
		EXT_MESH_GPU_INSTANCING: 'EXT_mesh_gpu_instancing'
	};

	/**
 * Punctual Lights Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_lights_punctual
 */
	class GLTFLightsExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_LIGHTS_PUNCTUAL;

			// THREE.Object3D instance caches
			this.cache = {
				refs: {},
				uses: {}
			};

		}
		_markDefs() {

			const parser = this.parser;
			const nodeDefs = this.parser.json.nodes || [];
			for ( let nodeIndex = 0, nodeLength = nodeDefs.length; nodeIndex < nodeLength; nodeIndex ++ ) {

				const nodeDef = nodeDefs[ nodeIndex ];
				if ( nodeDef.extensions && nodeDef.extensions[ this.name ] && nodeDef.extensions[ this.name ].light !== undefined ) {

					parser._addNodeRef( this.cache, nodeDef.extensions[ this.name ].light );

				}

			}

		}
		_loadLight( lightIndex ) {

			const parser = this.parser;
			const cacheKey = 'light:' + lightIndex;
			let dependency = parser.cache.get( cacheKey );
			if ( dependency ) return dependency;
			const json = parser.json;
			const extensions = json.extensions && json.extensions[ this.name ] || {};
			const lightDefs = extensions.lights || [];
			const lightDef = lightDefs[ lightIndex ];
			let lightNode;
			const color = new THREE.Color( 0xffffff );
			if ( lightDef.color !== undefined ) color.fromArray( lightDef.color );
			const range = lightDef.range !== undefined ? lightDef.range : 0;
			switch ( lightDef.type ) {

				case 'directional':
					lightNode = new THREE.DirectionalLight( color );
					lightNode.target.position.set( 0, 0, - 1 );
					lightNode.add( lightNode.target );
					break;
				case 'point':
					lightNode = new THREE.PointLight( color );
					lightNode.distance = range;
					break;
				case 'spot':
					lightNode = new THREE.SpotLight( color );
					lightNode.distance = range;
					// Handle spotlight properties.
					lightDef.spot = lightDef.spot || {};
					lightDef.spot.innerConeAngle = lightDef.spot.innerConeAngle !== undefined ? lightDef.spot.innerConeAngle : 0;
					lightDef.spot.outerConeAngle = lightDef.spot.outerConeAngle !== undefined ? lightDef.spot.outerConeAngle : Math.PI / 4.0;
					lightNode.angle = lightDef.spot.outerConeAngle;
					lightNode.penumbra = 1.0 - lightDef.spot.innerConeAngle / lightDef.spot.outerConeAngle;
					lightNode.target.position.set( 0, 0, - 1 );
					lightNode.add( lightNode.target );
					break;
				default:
					throw new Error( 'THREE.GLTFLoader: Unexpected light type: ' + lightDef.type );

			}

			// Some lights (e.g. spot) default to a position other than the origin. Reset the position
			// here, because node-level parsing will only override position if explicitly specified.
			lightNode.position.set( 0, 0, 0 );
			lightNode.decay = 2;
			assignExtrasToUserData( lightNode, lightDef );
			if ( lightDef.intensity !== undefined ) lightNode.intensity = lightDef.intensity;
			lightNode.name = parser.createUniqueName( lightDef.name || 'light_' + lightIndex );
			dependency = Promise.resolve( lightNode );
			parser.cache.add( cacheKey, dependency );
			return dependency;

		}
		getDependency( type, index ) {

			if ( type !== 'light' ) return;
			return this._loadLight( index );

		}
		createNodeAttachment( nodeIndex ) {

			const self = this;
			const parser = this.parser;
			const json = parser.json;
			const nodeDef = json.nodes[ nodeIndex ];
			const lightDef = nodeDef.extensions && nodeDef.extensions[ this.name ] || {};
			const lightIndex = lightDef.light;
			if ( lightIndex === undefined ) return null;
			return this._loadLight( lightIndex ).then( function ( light ) {

				return parser._getNodeRef( self.cache, lightIndex, light );

			} );

		}

	}

	/**
 * Unlit Materials Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_unlit
 */
	class GLTFMaterialsUnlitExtension {

		constructor() {

			this.name = EXTENSIONS.KHR_MATERIALS_UNLIT;

		}
		getMaterialType() {

			return THREE.MeshBasicMaterial;

		}
		extendParams( materialParams, materialDef, parser ) {

			const pending = [];
			materialParams.color = new THREE.Color( 1.0, 1.0, 1.0 );
			materialParams.opacity = 1.0;
			const metallicRoughness = materialDef.pbrMetallicRoughness;
			if ( metallicRoughness ) {

				if ( Array.isArray( metallicRoughness.baseColorFactor ) ) {

					const array = metallicRoughness.baseColorFactor;
					materialParams.color.fromArray( array );
					materialParams.opacity = array[ 3 ];

				}

				if ( metallicRoughness.baseColorTexture !== undefined ) {

					pending.push( parser.assignTexture( materialParams, 'map', metallicRoughness.baseColorTexture, THREE.sRGBEncoding ) );

				}

			}

			return Promise.all( pending );

		}

	}

	/**
 * Materials Emissive Strength Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/blob/5768b3ce0ef32bc39cdf1bef10b948586635ead3/extensions/2.0/Khronos/KHR_materials_emissive_strength/README.md
 */
	class GLTFMaterialsEmissiveStrengthExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_MATERIALS_EMISSIVE_STRENGTH;

		}
		extendMaterialParams( materialIndex, materialParams ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) {

				return Promise.resolve();

			}

			const emissiveStrength = materialDef.extensions[ this.name ].emissiveStrength;
			if ( emissiveStrength !== undefined ) {

				materialParams.emissiveIntensity = emissiveStrength;

			}

			return Promise.resolve();

		}

	}

	/**
 * Clearcoat Materials Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_clearcoat
 */
	class GLTFMaterialsClearcoatExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_MATERIALS_CLEARCOAT;

		}
		getMaterialType( materialIndex ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) return null;
			return THREE.MeshPhysicalMaterial;

		}
		extendMaterialParams( materialIndex, materialParams ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) {

				return Promise.resolve();

			}

			const pending = [];
			const extension = materialDef.extensions[ this.name ];
			if ( extension.clearcoatFactor !== undefined ) {

				materialParams.clearcoat = extension.clearcoatFactor;

			}

			if ( extension.clearcoatTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'clearcoatMap', extension.clearcoatTexture ) );

			}

			if ( extension.clearcoatRoughnessFactor !== undefined ) {

				materialParams.clearcoatRoughness = extension.clearcoatRoughnessFactor;

			}

			if ( extension.clearcoatRoughnessTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'clearcoatRoughnessMap', extension.clearcoatRoughnessTexture ) );

			}

			if ( extension.clearcoatNormalTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'clearcoatNormalMap', extension.clearcoatNormalTexture ) );
				if ( extension.clearcoatNormalTexture.scale !== undefined ) {

					const scale = extension.clearcoatNormalTexture.scale;
					materialParams.clearcoatNormalScale = new THREE.Vector2( scale, scale );

				}

			}

			return Promise.all( pending );

		}

	}

	/**
 * Iridescence Materials Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_iridescence
 */
	class GLTFMaterialsIridescenceExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_MATERIALS_IRIDESCENCE;

		}
		getMaterialType( materialIndex ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) return null;
			return THREE.MeshPhysicalMaterial;

		}
		extendMaterialParams( materialIndex, materialParams ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) {

				return Promise.resolve();

			}

			const pending = [];
			const extension = materialDef.extensions[ this.name ];
			if ( extension.iridescenceFactor !== undefined ) {

				materialParams.iridescence = extension.iridescenceFactor;

			}

			if ( extension.iridescenceTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'iridescenceMap', extension.iridescenceTexture ) );

			}

			if ( extension.iridescenceIor !== undefined ) {

				materialParams.iridescenceIOR = extension.iridescenceIor;

			}

			if ( materialParams.iridescenceThicknessRange === undefined ) {

				materialParams.iridescenceThicknessRange = [ 100, 400 ];

			}

			if ( extension.iridescenceThicknessMinimum !== undefined ) {

				materialParams.iridescenceThicknessRange[ 0 ] = extension.iridescenceThicknessMinimum;

			}

			if ( extension.iridescenceThicknessMaximum !== undefined ) {

				materialParams.iridescenceThicknessRange[ 1 ] = extension.iridescenceThicknessMaximum;

			}

			if ( extension.iridescenceThicknessTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'iridescenceThicknessMap', extension.iridescenceThicknessTexture ) );

			}

			return Promise.all( pending );

		}

	}

	/**
 * Sheen Materials Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_sheen
 */
	class GLTFMaterialsSheenExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_MATERIALS_SHEEN;

		}
		getMaterialType( materialIndex ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) return null;
			return THREE.MeshPhysicalMaterial;

		}
		extendMaterialParams( materialIndex, materialParams ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) {

				return Promise.resolve();

			}

			const pending = [];
			materialParams.sheenColor = new THREE.Color( 0, 0, 0 );
			materialParams.sheenRoughness = 0;
			materialParams.sheen = 1;
			const extension = materialDef.extensions[ this.name ];
			if ( extension.sheenColorFactor !== undefined ) {

				materialParams.sheenColor.fromArray( extension.sheenColorFactor );

			}

			if ( extension.sheenRoughnessFactor !== undefined ) {

				materialParams.sheenRoughness = extension.sheenRoughnessFactor;

			}

			if ( extension.sheenColorTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'sheenColorMap', extension.sheenColorTexture, THREE.sRGBEncoding ) );

			}

			if ( extension.sheenRoughnessTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'sheenRoughnessMap', extension.sheenRoughnessTexture ) );

			}

			return Promise.all( pending );

		}

	}

	/**
 * Transmission Materials Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_transmission
 * Draft: https://github.com/KhronosGroup/glTF/pull/1698
 */
	class GLTFMaterialsTransmissionExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_MATERIALS_TRANSMISSION;

		}
		getMaterialType( materialIndex ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) return null;
			return THREE.MeshPhysicalMaterial;

		}
		extendMaterialParams( materialIndex, materialParams ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) {

				return Promise.resolve();

			}

			const pending = [];
			const extension = materialDef.extensions[ this.name ];
			if ( extension.transmissionFactor !== undefined ) {

				materialParams.transmission = extension.transmissionFactor;

			}

			if ( extension.transmissionTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'transmissionMap', extension.transmissionTexture ) );

			}

			return Promise.all( pending );

		}

	}

	/**
 * Materials Volume Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_volume
 */
	class GLTFMaterialsVolumeExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_MATERIALS_VOLUME;

		}
		getMaterialType( materialIndex ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) return null;
			return THREE.MeshPhysicalMaterial;

		}
		extendMaterialParams( materialIndex, materialParams ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) {

				return Promise.resolve();

			}

			const pending = [];
			const extension = materialDef.extensions[ this.name ];
			materialParams.thickness = extension.thicknessFactor !== undefined ? extension.thicknessFactor : 0;
			if ( extension.thicknessTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'thicknessMap', extension.thicknessTexture ) );

			}

			materialParams.attenuationDistance = extension.attenuationDistance || Infinity;
			const colorArray = extension.attenuationColor || [ 1, 1, 1 ];
			materialParams.attenuationColor = new THREE.Color( colorArray[ 0 ], colorArray[ 1 ], colorArray[ 2 ] );
			return Promise.all( pending );

		}

	}

	/**
 * Materials ior Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_ior
 */
	class GLTFMaterialsIorExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_MATERIALS_IOR;

		}
		getMaterialType( materialIndex ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) return null;
			return THREE.MeshPhysicalMaterial;

		}
		extendMaterialParams( materialIndex, materialParams ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) {

				return Promise.resolve();

			}

			const extension = materialDef.extensions[ this.name ];
			materialParams.ior = extension.ior !== undefined ? extension.ior : 1.5;
			return Promise.resolve();

		}

	}

	/**
 * Materials specular Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_specular
 */
	class GLTFMaterialsSpecularExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_MATERIALS_SPECULAR;

		}
		getMaterialType( materialIndex ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) return null;
			return THREE.MeshPhysicalMaterial;

		}
		extendMaterialParams( materialIndex, materialParams ) {

			const parser = this.parser;
			const materialDef = parser.json.materials[ materialIndex ];
			if ( ! materialDef.extensions || ! materialDef.extensions[ this.name ] ) {

				return Promise.resolve();

			}

			const pending = [];
			const extension = materialDef.extensions[ this.name ];
			materialParams.specularIntensity = extension.specularFactor !== undefined ? extension.specularFactor : 1.0;
			if ( extension.specularTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'specularIntensityMap', extension.specularTexture ) );

			}

			const colorArray = extension.specularColorFactor || [ 1, 1, 1 ];
			materialParams.specularColor = new THREE.Color( colorArray[ 0 ], colorArray[ 1 ], colorArray[ 2 ] );
			if ( extension.specularColorTexture !== undefined ) {

				pending.push( parser.assignTexture( materialParams, 'specularColorMap', extension.specularColorTexture, THREE.sRGBEncoding ) );

			}

			return Promise.all( pending );

		}

	}

	/**
 * BasisU THREE.Texture Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_texture_basisu
 */
	class GLTFTextureBasisUExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.KHR_TEXTURE_BASISU;

		}
		loadTexture( textureIndex ) {

			const parser = this.parser;
			const json = parser.json;
			const textureDef = json.textures[ textureIndex ];
			if ( ! textureDef.extensions || ! textureDef.extensions[ this.name ] ) {

				return null;

			}

			const extension = textureDef.extensions[ this.name ];
			const loader = parser.options.ktx2Loader;
			if ( ! loader ) {

				if ( json.extensionsRequired && json.extensionsRequired.indexOf( this.name ) >= 0 ) {

					throw new Error( 'THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures' );

				} else {

					// Assumes that the extension is optional and that a fallback texture is present
					return null;

				}

			}

			return parser.loadTextureImage( textureIndex, extension.source, loader );

		}

	}

	/**
 * WebP THREE.Texture Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Vendor/EXT_texture_webp
 */
	class GLTFTextureWebPExtension {

		constructor( parser ) {

			this.parser = parser;
			this.name = EXTENSIONS.EXT_TEXTURE_WEBP;
			this.isSupported = null;

		}
		loadTexture( textureIndex ) {

			const name = this.name;
			const parser = this.parser;
			const json = parser.json;
			const textureDef = json.textures[ textureIndex ];
			if ( ! textureDef.extensions || ! textureDef.extensions[ name ] ) {

				return null;

			}

			const extension = textureDef.extensions[ name ];
			const source = json.images[ extension.source ];
			let loader = parser.textureLoader;
			if ( source.uri ) {

				const handler = parser.options.manager.getHandler( source.uri );
				if ( handler !== null ) loader = handler;

			}

			return this.detectSupport().then( function ( isSupported ) {

				if ( isSupported ) return parser.loadTextureImage( textureIndex, extension.source, loader );
				if ( json.extensionsRequired && json.extensionsRequired.indexOf( name ) >= 0 ) {

					throw new Error( 'THREE.GLTFLoader: WebP required by asset but unsupported.' );

				}

				// Fall back to PNG or JPEG.
				return parser.loadTexture( textureIndex );

			} );

		}
		detectSupport() {

			if ( ! this.isSupported ) {

				this.isSupported = new Promise( function ( resolve ) {

					const image = new Image();

					// Lossy test image. Support for lossy images doesn't guarantee support for all
					// WebP images, unfortunately.
					image.src = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
					image.onload = image.onerror = function () {

						resolve( image.height === 1 );

					};

				} );

			}

			return this.isSupported;

		}

	}

	/**
 * meshopt BufferView Compression Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Vendor/EXT_meshopt_compression
 */
	class GLTFMeshoptCompression {

		constructor( parser ) {

			this.name = EXTENSIONS.EXT_MESHOPT_COMPRESSION;
			this.parser = parser;

		}
		loadBufferView( index ) {

			const json = this.parser.json;
			const bufferView = json.bufferViews[ index ];
			if ( bufferView.extensions && bufferView.extensions[ this.name ] ) {

				const extensionDef = bufferView.extensions[ this.name ];
				const buffer = this.parser.getDependency( 'buffer', extensionDef.buffer );
				const decoder = this.parser.options.meshoptDecoder;
				if ( ! decoder || ! decoder.supported ) {

					if ( json.extensionsRequired && json.extensionsRequired.indexOf( this.name ) >= 0 ) {

						throw new Error( 'THREE.GLTFLoader: setMeshoptDecoder must be called before loading compressed files' );

					} else {

						// Assumes that the extension is optional and that fallback buffer data is present
						return null;

					}

				}

				return buffer.then( function ( res ) {

					const byteOffset = extensionDef.byteOffset || 0;
					const byteLength = extensionDef.byteLength || 0;
					const count = extensionDef.count;
					const stride = extensionDef.byteStride;
					const source = new Uint8Array( res, byteOffset, byteLength );
					if ( decoder.decodeGltfBufferAsync ) {

						return decoder.decodeGltfBufferAsync( count, stride, source, extensionDef.mode, extensionDef.filter ).then( function ( res ) {

							return res.buffer;

						} );

					} else {

						// Support for MeshoptDecoder 0.18 or earlier, without decodeGltfBufferAsync
						return decoder.ready.then( function () {

							const result = new ArrayBuffer( count * stride );
							decoder.decodeGltfBuffer( new Uint8Array( result ), count, stride, source, extensionDef.mode, extensionDef.filter );
							return result;

						} );

					}

				} );

			} else {

				return null;

			}

		}

	}

	/**
 * GPU Instancing Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Vendor/EXT_mesh_gpu_instancing
 *
 */
	class GLTFMeshGpuInstancing {

		constructor( parser ) {

			this.name = EXTENSIONS.EXT_MESH_GPU_INSTANCING;
			this.parser = parser;

		}
		createNodeMesh( nodeIndex ) {

			const json = this.parser.json;
			const nodeDef = json.nodes[ nodeIndex ];
			if ( ! nodeDef.extensions || ! nodeDef.extensions[ this.name ] || nodeDef.mesh === undefined ) {

				return null;

			}

			const meshDef = json.meshes[ nodeDef.mesh ];

			// No THREE.Points or Lines + Instancing support yet

			for ( const primitive of meshDef.primitives ) {

				if ( primitive.mode !== WEBGL_CONSTANTS.TRIANGLES && primitive.mode !== WEBGL_CONSTANTS.TRIANGLE_STRIP && primitive.mode !== WEBGL_CONSTANTS.TRIANGLE_FAN && primitive.mode !== undefined ) {

					return null;

				}

			}

			const extensionDef = nodeDef.extensions[ this.name ];
			const attributesDef = extensionDef.attributes;

			// @TODO: Can we support THREE.InstancedMesh + THREE.SkinnedMesh?

			const pending = [];
			const attributes = {};
			for ( const key in attributesDef ) {

				pending.push( this.parser.getDependency( 'accessor', attributesDef[ key ] ).then( accessor => {

					attributes[ key ] = accessor;
					return attributes[ key ];

				} ) );

			}

			if ( pending.length < 1 ) {

				return null;

			}

			pending.push( this.parser.createNodeMesh( nodeIndex ) );
			return Promise.all( pending ).then( results => {

				const nodeObject = results.pop();
				const meshes = nodeObject.isGroup ? nodeObject.children : [ nodeObject ];
				const count = results[ 0 ].count; // All attribute counts should be same
				const instancedMeshes = [];
				for ( const mesh of meshes ) {

					// Temporal variables
					const m = new THREE.Matrix4();
					const p = new THREE.Vector3();
					const q = new THREE.Quaternion();
					const s = new THREE.Vector3( 1, 1, 1 );
					const instancedMesh = new THREE.InstancedMesh( mesh.geometry, mesh.material, count );
					for ( let i = 0; i < count; i ++ ) {

						if ( attributes.TRANSLATION ) {

							p.fromBufferAttribute( attributes.TRANSLATION, i );

						}

						if ( attributes.ROTATION ) {

							q.fromBufferAttribute( attributes.ROTATION, i );

						}

						if ( attributes.SCALE ) {

							s.fromBufferAttribute( attributes.SCALE, i );

						}

						instancedMesh.setMatrixAt( i, m.compose( p, q, s ) );

					}

					// Add instance attributes to the geometry, excluding TRS.
					for ( const attributeName in attributes ) {

						if ( attributeName !== 'TRANSLATION' && attributeName !== 'ROTATION' && attributeName !== 'SCALE' ) {

							mesh.geometry.setAttribute( attributeName, attributes[ attributeName ] );

						}

					}

					// Just in case
					THREE.Object3D.prototype.copy.call( instancedMesh, mesh );

					// https://github.com/mrdoob/three.js/issues/18334
					instancedMesh.frustumCulled = false;
					this.parser.assignFinalMaterial( instancedMesh );
					instancedMeshes.push( instancedMesh );

				}

				if ( nodeObject.isGroup ) {

					nodeObject.clear();
					nodeObject.add( ...instancedMeshes );
					return nodeObject;

				}

				return instancedMeshes[ 0 ];

			} );

		}

	}

	/* BINARY EXTENSION */
	const BINARY_EXTENSION_HEADER_MAGIC = 'glTF';
	const BINARY_EXTENSION_HEADER_LENGTH = 12;
	const BINARY_EXTENSION_CHUNK_TYPES = {
		JSON: 0x4E4F534A,
		BIN: 0x004E4942
	};
	class GLTFBinaryExtension {

		constructor( data ) {

			this.name = EXTENSIONS.KHR_BINARY_GLTF;
			this.content = null;
			this.body = null;
			const headerView = new DataView( data, 0, BINARY_EXTENSION_HEADER_LENGTH );
			this.header = {
				magic: THREE.LoaderUtils.decodeText( new Uint8Array( data.slice( 0, 4 ) ) ),
				version: headerView.getUint32( 4, true ),
				length: headerView.getUint32( 8, true )
			};
			if ( this.header.magic !== BINARY_EXTENSION_HEADER_MAGIC ) {

				throw new Error( 'THREE.GLTFLoader: Unsupported glTF-Binary header.' );

			} else if ( this.header.version < 2.0 ) {

				throw new Error( 'THREE.GLTFLoader: Legacy binary file detected.' );

			}

			const chunkContentsLength = this.header.length - BINARY_EXTENSION_HEADER_LENGTH;
			const chunkView = new DataView( data, BINARY_EXTENSION_HEADER_LENGTH );
			let chunkIndex = 0;
			while ( chunkIndex < chunkContentsLength ) {

				const chunkLength = chunkView.getUint32( chunkIndex, true );
				chunkIndex += 4;
				const chunkType = chunkView.getUint32( chunkIndex, true );
				chunkIndex += 4;
				if ( chunkType === BINARY_EXTENSION_CHUNK_TYPES.JSON ) {

					const contentArray = new Uint8Array( data, BINARY_EXTENSION_HEADER_LENGTH + chunkIndex, chunkLength );
					this.content = THREE.LoaderUtils.decodeText( contentArray );

				} else if ( chunkType === BINARY_EXTENSION_CHUNK_TYPES.BIN ) {

					const byteOffset = BINARY_EXTENSION_HEADER_LENGTH + chunkIndex;
					this.body = data.slice( byteOffset, byteOffset + chunkLength );

				}

				// Clients must ignore chunks with unknown types.

				chunkIndex += chunkLength;

			}

			if ( this.content === null ) {

				throw new Error( 'THREE.GLTFLoader: JSON content not found.' );

			}

		}

	}

	/**
 * DRACO THREE.Mesh Compression Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_draco_mesh_compression
 */
	class GLTFDracoMeshCompressionExtension {

		constructor( json, dracoLoader ) {

			if ( ! dracoLoader ) {

				throw new Error( 'THREE.GLTFLoader: No DRACOLoader instance provided.' );

			}

			this.name = EXTENSIONS.KHR_DRACO_MESH_COMPRESSION;
			this.json = json;
			this.dracoLoader = dracoLoader;
			this.dracoLoader.preload();

		}
		decodePrimitive( primitive, parser ) {

			const json = this.json;
			const dracoLoader = this.dracoLoader;
			const bufferViewIndex = primitive.extensions[ this.name ].bufferView;
			const gltfAttributeMap = primitive.extensions[ this.name ].attributes;
			const threeAttributeMap = {};
			const attributeNormalizedMap = {};
			const attributeTypeMap = {};
			for ( const attributeName in gltfAttributeMap ) {

				const threeAttributeName = ATTRIBUTES[ attributeName ] || attributeName.toLowerCase();
				threeAttributeMap[ threeAttributeName ] = gltfAttributeMap[ attributeName ];

			}

			for ( const attributeName in primitive.attributes ) {

				const threeAttributeName = ATTRIBUTES[ attributeName ] || attributeName.toLowerCase();
				if ( gltfAttributeMap[ attributeName ] !== undefined ) {

					const accessorDef = json.accessors[ primitive.attributes[ attributeName ] ];
					const componentType = WEBGL_COMPONENT_TYPES[ accessorDef.componentType ];
					attributeTypeMap[ threeAttributeName ] = componentType.name;
					attributeNormalizedMap[ threeAttributeName ] = accessorDef.normalized === true;

				}

			}

			return parser.getDependency( 'bufferView', bufferViewIndex ).then( function ( bufferView ) {

				return new Promise( function ( resolve ) {

					dracoLoader.decodeDracoFile( bufferView, function ( geometry ) {

						for ( const attributeName in geometry.attributes ) {

							const attribute = geometry.attributes[ attributeName ];
							const normalized = attributeNormalizedMap[ attributeName ];
							if ( normalized !== undefined ) attribute.normalized = normalized;

						}

						resolve( geometry );

					}, threeAttributeMap, attributeTypeMap );

				} );

			} );

		}

	}

	/**
 * THREE.Texture Transform Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_texture_transform
 */
	class GLTFTextureTransformExtension {

		constructor() {

			this.name = EXTENSIONS.KHR_TEXTURE_TRANSFORM;

		}
		extendTexture( texture, transform ) {

			if ( transform.texCoord !== undefined ) {

				console.warn( 'THREE.GLTFLoader: Custom UV sets in "' + this.name + '" extension not yet supported.' );

			}

			if ( transform.offset === undefined && transform.rotation === undefined && transform.scale === undefined ) {

				// See https://github.com/mrdoob/three.js/issues/21819.
				return texture;

			}

			texture = texture.clone();
			if ( transform.offset !== undefined ) {

				texture.offset.fromArray( transform.offset );

			}

			if ( transform.rotation !== undefined ) {

				texture.rotation = transform.rotation;

			}

			if ( transform.scale !== undefined ) {

				texture.repeat.fromArray( transform.scale );

			}

			texture.needsUpdate = true;
			return texture;

		}

	}

	/**
 * THREE.Mesh Quantization Extension
 *
 * Specification: https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_mesh_quantization
 */
	class GLTFMeshQuantizationExtension {

		constructor() {

			this.name = EXTENSIONS.KHR_MESH_QUANTIZATION;

		}

	}

	/*********************************/
	/********** INTERPOLATION ********/
	/*********************************/

	// Spline Interpolation
	// Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#appendix-c-spline-interpolation
	class GLTFCubicSplineInterpolant extends THREE.Interpolant {

		constructor( parameterPositions, sampleValues, sampleSize, resultBuffer ) {

			super( parameterPositions, sampleValues, sampleSize, resultBuffer );

		}
		copySampleValue_( index ) {

			// Copies a sample value to the result buffer. See description of glTF
			// CUBICSPLINE values layout in interpolate_() function below.

			const result = this.resultBuffer,
				values = this.sampleValues,
				valueSize = this.valueSize,
				offset = index * valueSize * 3 + valueSize;
			for ( let i = 0; i !== valueSize; i ++ ) {

				result[ i ] = values[ offset + i ];

			}

			return result;

		}
		interpolate_( i1, t0, t, t1 ) {

			const result = this.resultBuffer;
			const values = this.sampleValues;
			const stride = this.valueSize;
			const stride2 = stride * 2;
			const stride3 = stride * 3;
			const td = t1 - t0;
			const p = ( t - t0 ) / td;
			const pp = p * p;
			const ppp = pp * p;
			const offset1 = i1 * stride3;
			const offset0 = offset1 - stride3;
			const s2 = - 2 * ppp + 3 * pp;
			const s3 = ppp - pp;
			const s0 = 1 - s2;
			const s1 = s3 - pp + p;

			// Layout of keyframe output values for CUBICSPLINE animations:
			//   [ inTangent_1, splineVertex_1, outTangent_1, inTangent_2, splineVertex_2, ... ]
			for ( let i = 0; i !== stride; i ++ ) {

				const p0 = values[ offset0 + i + stride ]; // splineVertex_k
				const m0 = values[ offset0 + i + stride2 ] * td; // outTangent_k * (t_k+1 - t_k)
				const p1 = values[ offset1 + i + stride ]; // splineVertex_k+1
				const m1 = values[ offset1 + i ] * td; // inTangent_k+1 * (t_k+1 - t_k)

				result[ i ] = s0 * p0 + s1 * m0 + s2 * p1 + s3 * m1;

			}

			return result;

		}

	}
	const _q = new THREE.Quaternion();
	class GLTFCubicSplineQuaternionInterpolant extends GLTFCubicSplineInterpolant {

		interpolate_( i1, t0, t, t1 ) {

			const result = super.interpolate_( i1, t0, t, t1 );
			_q.fromArray( result ).normalize().toArray( result );
			return result;

		}

	}

	/*********************************/
	/********** INTERNALS ************/
	/*********************************/

	/* CONSTANTS */

	const WEBGL_CONSTANTS = {
		FLOAT: 5126,
		//FLOAT_MAT2: 35674,
		FLOAT_MAT3: 35675,
		FLOAT_MAT4: 35676,
		FLOAT_VEC2: 35664,
		FLOAT_VEC3: 35665,
		FLOAT_VEC4: 35666,
		LINEAR: 9729,
		REPEAT: 10497,
		SAMPLER_2D: 35678,
		POINTS: 0,
		LINES: 1,
		LINE_LOOP: 2,
		LINE_STRIP: 3,
		TRIANGLES: 4,
		TRIANGLE_STRIP: 5,
		TRIANGLE_FAN: 6,
		UNSIGNED_BYTE: 5121,
		UNSIGNED_SHORT: 5123
	};
	const WEBGL_COMPONENT_TYPES = {
		5120: Int8Array,
		5121: Uint8Array,
		5122: Int16Array,
		5123: Uint16Array,
		5125: Uint32Array,
		5126: Float32Array
	};
	const WEBGL_FILTERS = {
		9728: THREE.NearestFilter,
		9729: THREE.LinearFilter,
		9984: THREE.NearestMipmapNearestFilter,
		9985: THREE.LinearMipmapNearestFilter,
		9986: THREE.NearestMipmapLinearFilter,
		9987: THREE.LinearMipmapLinearFilter
	};
	const WEBGL_WRAPPINGS = {
		33071: THREE.ClampToEdgeWrapping,
		33648: THREE.MirroredRepeatWrapping,
		10497: THREE.RepeatWrapping
	};
	const WEBGL_TYPE_SIZES = {
		'SCALAR': 1,
		'VEC2': 2,
		'VEC3': 3,
		'VEC4': 4,
		'MAT2': 4,
		'MAT3': 9,
		'MAT4': 16
	};
	const ATTRIBUTES = {
		POSITION: 'position',
		NORMAL: 'normal',
		TANGENT: 'tangent',
		TEXCOORD_0: 'uv',
		TEXCOORD_1: 'uv2',
		COLOR_0: 'color',
		WEIGHTS_0: 'skinWeight',
		JOINTS_0: 'skinIndex'
	};
	const PATH_PROPERTIES = {
		scale: 'scale',
		translation: 'position',
		rotation: 'quaternion',
		weights: 'morphTargetInfluences'
	};
	const INTERPOLATION = {
		CUBICSPLINE: undefined,
		// We use a custom interpolant (GLTFCubicSplineInterpolation) for CUBICSPLINE tracks. Each
		// keyframe track will be initialized with a default interpolation type, then modified.
		LINEAR: THREE.InterpolateLinear,
		STEP: THREE.InterpolateDiscrete
	};
	const ALPHA_MODES = {
		OPAQUE: 'OPAQUE',
		MASK: 'MASK',
		BLEND: 'BLEND'
	};

	/**
 * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#default-material
 */
	function createDefaultMaterial( cache ) {

		if ( cache[ 'DefaultMaterial' ] === undefined ) {

			cache[ 'DefaultMaterial' ] = new THREE.MeshStandardMaterial( {
				color: 0xFFFFFF,
				emissive: 0x000000,
				metalness: 1,
				roughness: 1,
				transparent: false,
				depthTest: true,
				side: THREE.FrontSide
			} );

		}

		return cache[ 'DefaultMaterial' ];

	}

	function addUnknownExtensionsToUserData( knownExtensions, object, objectDef ) {

		// Add unknown glTF extensions to an object's userData.

		for ( const name in objectDef.extensions ) {

			if ( knownExtensions[ name ] === undefined ) {

				object.userData.gltfExtensions = object.userData.gltfExtensions || {};
				object.userData.gltfExtensions[ name ] = objectDef.extensions[ name ];

			}

		}

	}

	/**
 * @param {Object3D|Material|BufferGeometry} object
 * @param {GLTF.definition} gltfDef
 */
	function assignExtrasToUserData( object, gltfDef ) {

		if ( gltfDef.extras !== undefined ) {

			if ( typeof gltfDef.extras === 'object' ) {

				Object.assign( object.userData, gltfDef.extras );

			} else {

				console.warn( 'THREE.GLTFLoader: Ignoring primitive type .extras, ' + gltfDef.extras );

			}

		}

	}

	/**
 * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#morph-targets
 *
 * @param {BufferGeometry} geometry
 * @param {Array<GLTF.Target>} targets
 * @param {GLTFParser} parser
 * @return {Promise<BufferGeometry>}
 */
	function addMorphTargets( geometry, targets, parser ) {

		let hasMorphPosition = false;
		let hasMorphNormal = false;
		let hasMorphColor = false;
		for ( let i = 0, il = targets.length; i < il; i ++ ) {

			const target = targets[ i ];
			if ( target.POSITION !== undefined ) hasMorphPosition = true;
			if ( target.NORMAL !== undefined ) hasMorphNormal = true;
			if ( target.COLOR_0 !== undefined ) hasMorphColor = true;
			if ( hasMorphPosition && hasMorphNormal && hasMorphColor ) break;

		}

		if ( ! hasMorphPosition && ! hasMorphNormal && ! hasMorphColor ) return Promise.resolve( geometry );
		const pendingPositionAccessors = [];
		const pendingNormalAccessors = [];
		const pendingColorAccessors = [];
		for ( let i = 0, il = targets.length; i < il; i ++ ) {

			const target = targets[ i ];
			if ( hasMorphPosition ) {

				const pendingAccessor = target.POSITION !== undefined ? parser.getDependency( 'accessor', target.POSITION ) : geometry.attributes.position;
				pendingPositionAccessors.push( pendingAccessor );

			}

			if ( hasMorphNormal ) {

				const pendingAccessor = target.NORMAL !== undefined ? parser.getDependency( 'accessor', target.NORMAL ) : geometry.attributes.normal;
				pendingNormalAccessors.push( pendingAccessor );

			}

			if ( hasMorphColor ) {

				const pendingAccessor = target.COLOR_0 !== undefined ? parser.getDependency( 'accessor', target.COLOR_0 ) : geometry.attributes.color;
				pendingColorAccessors.push( pendingAccessor );

			}

		}

		return Promise.all( [ Promise.all( pendingPositionAccessors ), Promise.all( pendingNormalAccessors ), Promise.all( pendingColorAccessors ) ] ).then( function ( accessors ) {

			const morphPositions = accessors[ 0 ];
			const morphNormals = accessors[ 1 ];
			const morphColors = accessors[ 2 ];
			if ( hasMorphPosition ) geometry.morphAttributes.position = morphPositions;
			if ( hasMorphNormal ) geometry.morphAttributes.normal = morphNormals;
			if ( hasMorphColor ) geometry.morphAttributes.color = morphColors;
			geometry.morphTargetsRelative = true;
			return geometry;

		} );

	}

	/**
 * @param {Mesh} mesh
 * @param {GLTF.Mesh} meshDef
 */
	function updateMorphTargets( mesh, meshDef ) {

		mesh.updateMorphTargets();
		if ( meshDef.weights !== undefined ) {

			for ( let i = 0, il = meshDef.weights.length; i < il; i ++ ) {

				mesh.morphTargetInfluences[ i ] = meshDef.weights[ i ];

			}

		}

		// .extras has user-defined data, so check that .extras.targetNames is an array.
		if ( meshDef.extras && Array.isArray( meshDef.extras.targetNames ) ) {

			const targetNames = meshDef.extras.targetNames;
			if ( mesh.morphTargetInfluences.length === targetNames.length ) {

				mesh.morphTargetDictionary = {};
				for ( let i = 0, il = targetNames.length; i < il; i ++ ) {

					mesh.morphTargetDictionary[ targetNames[ i ] ] = i;

				}

			} else {

				console.warn( 'THREE.GLTFLoader: Invalid extras.targetNames length. Ignoring names.' );

			}

		}

	}

	function createPrimitiveKey( primitiveDef ) {

		const dracoExtension = primitiveDef.extensions && primitiveDef.extensions[ EXTENSIONS.KHR_DRACO_MESH_COMPRESSION ];
		let geometryKey;
		if ( dracoExtension ) {

			geometryKey = 'draco:' + dracoExtension.bufferView + ':' + dracoExtension.indices + ':' + createAttributesKey( dracoExtension.attributes );

		} else {

			geometryKey = primitiveDef.indices + ':' + createAttributesKey( primitiveDef.attributes ) + ':' + primitiveDef.mode;

		}

		return geometryKey;

	}

	function createAttributesKey( attributes ) {

		let attributesKey = '';
		const keys = Object.keys( attributes ).sort();
		for ( let i = 0, il = keys.length; i < il; i ++ ) {

			attributesKey += keys[ i ] + ':' + attributes[ keys[ i ] ] + ';';

		}

		return attributesKey;

	}

	function getNormalizedComponentScale( constructor ) {

		// Reference:
		// https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_mesh_quantization#encoding-quantized-data

		switch ( constructor ) {

			case Int8Array:
				return 1 / 127;
			case Uint8Array:
				return 1 / 255;
			case Int16Array:
				return 1 / 32767;
			case Uint16Array:
				return 1 / 65535;
			default:
				throw new Error( 'THREE.GLTFLoader: Unsupported normalized accessor component type.' );

		}

	}

	function getImageURIMimeType( uri ) {

		if ( uri.search( /\.jpe?g($|\?)/i ) > 0 || uri.search( /^data\:image\/jpeg/ ) === 0 ) return 'image/jpeg';
		if ( uri.search( /\.webp($|\?)/i ) > 0 || uri.search( /^data\:image\/webp/ ) === 0 ) return 'image/webp';
		return 'image/png';

	}

	/* GLTF PARSER */

	class GLTFParser {

		constructor( json = {}, options = {} ) {

			this.json = json;
			this.extensions = {};
			this.plugins = {};
			this.options = options;

			// loader object cache
			this.cache = new GLTFRegistry();

			// associations between Three.js objects and glTF elements
			this.associations = new Map();

			// THREE.BufferGeometry caching
			this.primitiveCache = {};

			// THREE.Object3D instance caches
			this.meshCache = {
				refs: {},
				uses: {}
			};
			this.cameraCache = {
				refs: {},
				uses: {}
			};
			this.lightCache = {
				refs: {},
				uses: {}
			};
			this.sourceCache = {};
			this.textureCache = {};

			// Track node names, to ensure no duplicates
			this.nodeNamesUsed = {};

			// Use an THREE.ImageBitmapLoader if imageBitmaps are supported. Moves much of the
			// expensive work of uploading a texture to the GPU off the main thread.

			let isSafari = false;
			let isFirefox = false;
			let firefoxVersion = - 1;
			if ( typeof navigator !== 'undefined' ) {

				isSafari = /^((?!chrome|android).)*safari/i.test( navigator.userAgent ) === true;
				isFirefox = navigator.userAgent.indexOf( 'Firefox' ) > - 1;
				firefoxVersion = isFirefox ? navigator.userAgent.match( /Firefox\/([0-9]+)\./ )[ 1 ] : - 1;

			}

			if ( typeof createImageBitmap === 'undefined' || isSafari || isFirefox && firefoxVersion < 98 ) {

				this.textureLoader = new THREE.TextureLoader( this.options.manager );

			} else {

				this.textureLoader = new THREE.ImageBitmapLoader( this.options.manager );

			}

			this.textureLoader.setCrossOrigin( this.options.crossOrigin );
			this.textureLoader.setRequestHeader( this.options.requestHeader );
			this.fileLoader = new THREE.FileLoader( this.options.manager );
			this.fileLoader.setResponseType( 'arraybuffer' );
			if ( this.options.crossOrigin === 'use-credentials' ) {

				this.fileLoader.setWithCredentials( true );

			}

		}
		setExtensions( extensions ) {

			this.extensions = extensions;

		}
		setPlugins( plugins ) {

			this.plugins = plugins;

		}
		parse( onLoad, onError ) {

			const parser = this;
			const json = this.json;
			const extensions = this.extensions;

			// Clear the loader cache
			this.cache.removeAll();

			// Mark the special nodes/meshes in json for efficient parse
			this._invokeAll( function ( ext ) {

				return ext._markDefs && ext._markDefs();

			} );
			Promise.all( this._invokeAll( function ( ext ) {

				return ext.beforeRoot && ext.beforeRoot();

			} ) ).then( function () {

				return Promise.all( [ parser.getDependencies( 'scene' ), parser.getDependencies( 'animation' ), parser.getDependencies( 'camera' ) ] );

			} ).then( function ( dependencies ) {

				const result = {
					scene: dependencies[ 0 ][ json.scene || 0 ],
					scenes: dependencies[ 0 ],
					animations: dependencies[ 1 ],
					cameras: dependencies[ 2 ],
					asset: json.asset,
					parser: parser,
					userData: {}
				};
				addUnknownExtensionsToUserData( extensions, result, json );
				assignExtrasToUserData( result, json );
				Promise.all( parser._invokeAll( function ( ext ) {

					return ext.afterRoot && ext.afterRoot( result );

				} ) ).then( function () {

					onLoad( result );

				} );

			} ).catch( onError );

		}

		/**
   * Marks the special nodes/meshes in json for efficient parse.
   */
		_markDefs() {

			const nodeDefs = this.json.nodes || [];
			const skinDefs = this.json.skins || [];
			const meshDefs = this.json.meshes || [];

			// Nothing in the node definition indicates whether it is a THREE.Bone or an
			// THREE.Object3D. Use the skins' joint references to mark bones.
			for ( let skinIndex = 0, skinLength = skinDefs.length; skinIndex < skinLength; skinIndex ++ ) {

				const joints = skinDefs[ skinIndex ].joints;
				for ( let i = 0, il = joints.length; i < il; i ++ ) {

					nodeDefs[ joints[ i ] ].isBone = true;

				}

			}

			// Iterate over all nodes, marking references to shared resources,
			// as well as skeleton joints.
			for ( let nodeIndex = 0, nodeLength = nodeDefs.length; nodeIndex < nodeLength; nodeIndex ++ ) {

				const nodeDef = nodeDefs[ nodeIndex ];
				if ( nodeDef.mesh !== undefined ) {

					this._addNodeRef( this.meshCache, nodeDef.mesh );

					// Nothing in the mesh definition indicates whether it is
					// a THREE.SkinnedMesh or THREE.Mesh. Use the node's mesh reference
					// to mark THREE.SkinnedMesh if node has skin.
					if ( nodeDef.skin !== undefined ) {

						meshDefs[ nodeDef.mesh ].isSkinnedMesh = true;

					}

				}

				if ( nodeDef.camera !== undefined ) {

					this._addNodeRef( this.cameraCache, nodeDef.camera );

				}

			}

		}

		/**
   * Counts references to shared node / THREE.Object3D resources. These resources
   * can be reused, or "instantiated", at multiple nodes in the scene
   * hierarchy. THREE.Mesh, Camera, and Light instances are instantiated and must
   * be marked. Non-scenegraph resources (like Materials, Geometries, and
   * Textures) can be reused directly and are not marked here.
   *
   * Example: CesiumMilkTruck sample model reuses "Wheel" meshes.
   */
		_addNodeRef( cache, index ) {

			if ( index === undefined ) return;
			if ( cache.refs[ index ] === undefined ) {

				cache.refs[ index ] = cache.uses[ index ] = 0;

			}

			cache.refs[ index ] ++;

		}

		/** Returns a reference to a shared resource, cloning it if necessary. */
		_getNodeRef( cache, index, object ) {

			if ( cache.refs[ index ] <= 1 ) return object;
			const ref = object.clone();

			// Propagates mappings to the cloned object, prevents mappings on the
			// original object from being lost.
			const updateMappings = ( original, clone ) => {

				const mappings = this.associations.get( original );
				if ( mappings != null ) {

					this.associations.set( clone, mappings );

				}

				for ( const [ i, child ] of original.children.entries() ) {

					updateMappings( child, clone.children[ i ] );

				}

			};

			updateMappings( object, ref );
			ref.name += '_instance_' + cache.uses[ index ] ++;
			return ref;

		}
		_invokeOne( func ) {

			const extensions = Object.values( this.plugins );
			extensions.push( this );
			for ( let i = 0; i < extensions.length; i ++ ) {

				const result = func( extensions[ i ] );
				if ( result ) return result;

			}

			return null;

		}
		_invokeAll( func ) {

			const extensions = Object.values( this.plugins );
			extensions.unshift( this );
			const pending = [];
			for ( let i = 0; i < extensions.length; i ++ ) {

				const result = func( extensions[ i ] );
				if ( result ) pending.push( result );

			}

			return pending;

		}

		/**
   * Requests the specified dependency asynchronously, with caching.
   * @param {string} type
   * @param {number} index
   * @return {Promise<Object3D|Material|THREE.Texture|AnimationClip|ArrayBuffer|Object>}
   */
		getDependency( type, index ) {

			const cacheKey = type + ':' + index;
			let dependency = this.cache.get( cacheKey );
			if ( ! dependency ) {

				switch ( type ) {

					case 'scene':
						dependency = this.loadScene( index );
						break;
					case 'node':
						dependency = this.loadNode( index );
						break;
					case 'mesh':
						dependency = this._invokeOne( function ( ext ) {

							return ext.loadMesh && ext.loadMesh( index );

						} );
						break;
					case 'accessor':
						dependency = this.loadAccessor( index );
						break;
					case 'bufferView':
						dependency = this._invokeOne( function ( ext ) {

							return ext.loadBufferView && ext.loadBufferView( index );

						} );
						break;
					case 'buffer':
						dependency = this.loadBuffer( index );
						break;
					case 'material':
						dependency = this._invokeOne( function ( ext ) {

							return ext.loadMaterial && ext.loadMaterial( index );

						} );
						break;
					case 'texture':
						dependency = this._invokeOne( function ( ext ) {

							return ext.loadTexture && ext.loadTexture( index );

						} );
						break;
					case 'skin':
						dependency = this.loadSkin( index );
						break;
					case 'animation':
						dependency = this._invokeOne( function ( ext ) {

							return ext.loadAnimation && ext.loadAnimation( index );

						} );
						break;
					case 'camera':
						dependency = this.loadCamera( index );
						break;
					default:
						dependency = this._invokeOne( function ( ext ) {

							return ext != this && ext.getDependency && ext.getDependency( type, index );

						} );
						if ( ! dependency ) {

							throw new Error( 'Unknown type: ' + type );

						}

						break;

				}

				this.cache.add( cacheKey, dependency );

			}

			return dependency;

		}

		/**
   * Requests all dependencies of the specified type asynchronously, with caching.
   * @param {string} type
   * @return {Promise<Array<Object>>}
   */
		getDependencies( type ) {

			let dependencies = this.cache.get( type );
			if ( ! dependencies ) {

				const parser = this;
				const defs = this.json[ type + ( type === 'mesh' ? 'es' : 's' ) ] || [];
				dependencies = Promise.all( defs.map( function ( def, index ) {

					return parser.getDependency( type, index );

				} ) );
				this.cache.add( type, dependencies );

			}

			return dependencies;

		}

		/**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#buffers-and-buffer-views
   * @param {number} bufferIndex
   * @return {Promise<ArrayBuffer>}
   */
		loadBuffer( bufferIndex ) {

			const bufferDef = this.json.buffers[ bufferIndex ];
			const loader = this.fileLoader;
			if ( bufferDef.type && bufferDef.type !== 'arraybuffer' ) {

				throw new Error( 'THREE.GLTFLoader: ' + bufferDef.type + ' buffer type is not supported.' );

			}

			// If present, GLB container is required to be the first buffer.
			if ( bufferDef.uri === undefined && bufferIndex === 0 ) {

				return Promise.resolve( this.extensions[ EXTENSIONS.KHR_BINARY_GLTF ].body );

			}

			const options = this.options;
			return new Promise( function ( resolve, reject ) {

				loader.load( THREE.LoaderUtils.resolveURL( bufferDef.uri, options.path ), resolve, undefined, function () {

					reject( new Error( 'THREE.GLTFLoader: Failed to load buffer "' + bufferDef.uri + '".' ) );

				} );

			} );

		}

		/**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#buffers-and-buffer-views
   * @param {number} bufferViewIndex
   * @return {Promise<ArrayBuffer>}
   */
		loadBufferView( bufferViewIndex ) {

			const bufferViewDef = this.json.bufferViews[ bufferViewIndex ];
			return this.getDependency( 'buffer', bufferViewDef.buffer ).then( function ( buffer ) {

				const byteLength = bufferViewDef.byteLength || 0;
				const byteOffset = bufferViewDef.byteOffset || 0;
				return buffer.slice( byteOffset, byteOffset + byteLength );

			} );

		}

		/**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#accessors
   * @param {number} accessorIndex
   * @return {Promise<BufferAttribute|InterleavedBufferAttribute>}
   */
		loadAccessor( accessorIndex ) {

			const parser = this;
			const json = this.json;
			const accessorDef = this.json.accessors[ accessorIndex ];
			if ( accessorDef.bufferView === undefined && accessorDef.sparse === undefined ) {

				const itemSize = WEBGL_TYPE_SIZES[ accessorDef.type ];
				const TypedArray = WEBGL_COMPONENT_TYPES[ accessorDef.componentType ];
				const normalized = accessorDef.normalized === true;
				const array = new TypedArray( accessorDef.count * itemSize );
				return Promise.resolve( new THREE.BufferAttribute( array, itemSize, normalized ) );

			}

			const pendingBufferViews = [];
			if ( accessorDef.bufferView !== undefined ) {

				pendingBufferViews.push( this.getDependency( 'bufferView', accessorDef.bufferView ) );

			} else {

				pendingBufferViews.push( null );

			}

			if ( accessorDef.sparse !== undefined ) {

				pendingBufferViews.push( this.getDependency( 'bufferView', accessorDef.sparse.indices.bufferView ) );
				pendingBufferViews.push( this.getDependency( 'bufferView', accessorDef.sparse.values.bufferView ) );

			}

			return Promise.all( pendingBufferViews ).then( function ( bufferViews ) {

				const bufferView = bufferViews[ 0 ];
				const itemSize = WEBGL_TYPE_SIZES[ accessorDef.type ];
				const TypedArray = WEBGL_COMPONENT_TYPES[ accessorDef.componentType ];

				// For VEC3: itemSize is 3, elementBytes is 4, itemBytes is 12.
				const elementBytes = TypedArray.BYTES_PER_ELEMENT;
				const itemBytes = elementBytes * itemSize;
				const byteOffset = accessorDef.byteOffset || 0;
				const byteStride = accessorDef.bufferView !== undefined ? json.bufferViews[ accessorDef.bufferView ].byteStride : undefined;
				const normalized = accessorDef.normalized === true;
				let array, bufferAttribute;

				// The buffer is not interleaved if the stride is the item size in bytes.
				if ( byteStride && byteStride !== itemBytes ) {

					// Each "slice" of the buffer, as defined by 'count' elements of 'byteStride' bytes, gets its own THREE.InterleavedBuffer
					// This makes sure that IBA.count reflects accessor.count properly
					const ibSlice = Math.floor( byteOffset / byteStride );
					const ibCacheKey = 'InterleavedBuffer:' + accessorDef.bufferView + ':' + accessorDef.componentType + ':' + ibSlice + ':' + accessorDef.count;
					let ib = parser.cache.get( ibCacheKey );
					if ( ! ib ) {

						array = new TypedArray( bufferView, ibSlice * byteStride, accessorDef.count * byteStride / elementBytes );

						// Integer parameters to IB/IBA are in array elements, not bytes.
						ib = new THREE.InterleavedBuffer( array, byteStride / elementBytes );
						parser.cache.add( ibCacheKey, ib );

					}

					bufferAttribute = new THREE.InterleavedBufferAttribute( ib, itemSize, byteOffset % byteStride / elementBytes, normalized );

				} else {

					if ( bufferView === null ) {

						array = new TypedArray( accessorDef.count * itemSize );

					} else {

						array = new TypedArray( bufferView, byteOffset, accessorDef.count * itemSize );

					}

					bufferAttribute = new THREE.BufferAttribute( array, itemSize, normalized );

				}

				// https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#sparse-accessors
				if ( accessorDef.sparse !== undefined ) {

					const itemSizeIndices = WEBGL_TYPE_SIZES.SCALAR;
					const TypedArrayIndices = WEBGL_COMPONENT_TYPES[ accessorDef.sparse.indices.componentType ];
					const byteOffsetIndices = accessorDef.sparse.indices.byteOffset || 0;
					const byteOffsetValues = accessorDef.sparse.values.byteOffset || 0;
					const sparseIndices = new TypedArrayIndices( bufferViews[ 1 ], byteOffsetIndices, accessorDef.sparse.count * itemSizeIndices );
					const sparseValues = new TypedArray( bufferViews[ 2 ], byteOffsetValues, accessorDef.sparse.count * itemSize );
					if ( bufferView !== null ) {

						// Avoid modifying the original ArrayBuffer, if the bufferView wasn't initialized with zeroes.
						bufferAttribute = new THREE.BufferAttribute( bufferAttribute.array.slice(), bufferAttribute.itemSize, bufferAttribute.normalized );

					}

					for ( let i = 0, il = sparseIndices.length; i < il; i ++ ) {

						const index = sparseIndices[ i ];
						bufferAttribute.setX( index, sparseValues[ i * itemSize ] );
						if ( itemSize >= 2 ) bufferAttribute.setY( index, sparseValues[ i * itemSize + 1 ] );
						if ( itemSize >= 3 ) bufferAttribute.setZ( index, sparseValues[ i * itemSize + 2 ] );
						if ( itemSize >= 4 ) bufferAttribute.setW( index, sparseValues[ i * itemSize + 3 ] );
						if ( itemSize >= 5 ) throw new Error( 'THREE.GLTFLoader: Unsupported itemSize in sparse THREE.BufferAttribute.' );

					}

				}

				return bufferAttribute;

			} );

		}

		/**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#textures
   * @param {number} textureIndex
   * @return {Promise<THREE.Texture|null>}
   */
		loadTexture( textureIndex ) {

			const json = this.json;
			const options = this.options;
			const textureDef = json.textures[ textureIndex ];
			const sourceIndex = textureDef.source;
			const sourceDef = json.images[ sourceIndex ];
			let loader = this.textureLoader;
			if ( sourceDef.uri ) {

				const handler = options.manager.getHandler( sourceDef.uri );
				if ( handler !== null ) loader = handler;

			}

			return this.loadTextureImage( textureIndex, sourceIndex, loader );

		}
		loadTextureImage( textureIndex, sourceIndex, loader ) {

			const parser = this;
			const json = this.json;
			const textureDef = json.textures[ textureIndex ];
			const sourceDef = json.images[ sourceIndex ];
			const cacheKey = ( sourceDef.uri || sourceDef.bufferView ) + ':' + textureDef.sampler;
			if ( this.textureCache[ cacheKey ] ) {

				// See https://github.com/mrdoob/three.js/issues/21559.
				return this.textureCache[ cacheKey ];

			}

			const promise = this.loadImageSource( sourceIndex, loader ).then( function ( texture ) {

				texture.flipY = false;
				texture.name = textureDef.name || sourceDef.name || '';
				const samplers = json.samplers || {};
				const sampler = samplers[ textureDef.sampler ] || {};
				texture.magFilter = WEBGL_FILTERS[ sampler.magFilter ] || THREE.LinearFilter;
				texture.minFilter = WEBGL_FILTERS[ sampler.minFilter ] || THREE.LinearMipmapLinearFilter;
				texture.wrapS = WEBGL_WRAPPINGS[ sampler.wrapS ] || THREE.RepeatWrapping;
				texture.wrapT = WEBGL_WRAPPINGS[ sampler.wrapT ] || THREE.RepeatWrapping;
				parser.associations.set( texture, {
					textures: textureIndex
				} );
				return texture;

			} ).catch( function () {

				return null;

			} );
			this.textureCache[ cacheKey ] = promise;
			return promise;

		}
		loadImageSource( sourceIndex, loader ) {

			const parser = this;
			const json = this.json;
			const options = this.options;
			if ( this.sourceCache[ sourceIndex ] !== undefined ) {

				return this.sourceCache[ sourceIndex ].then( texture => texture.clone() );

			}

			const sourceDef = json.images[ sourceIndex ];
			const URL = self.URL || self.webkitURL;
			let sourceURI = sourceDef.uri || '';
			let isObjectURL = false;
			if ( sourceDef.bufferView !== undefined ) {

				// Load binary image data from bufferView, if provided.

				sourceURI = parser.getDependency( 'bufferView', sourceDef.bufferView ).then( function ( bufferView ) {

					isObjectURL = true;
					const blob = new Blob( [ bufferView ], {
						type: sourceDef.mimeType
					} );
					sourceURI = URL.createObjectURL( blob );
					return sourceURI;

				} );

			} else if ( sourceDef.uri === undefined ) {

				throw new Error( 'THREE.GLTFLoader: Image ' + sourceIndex + ' is missing URI and bufferView' );

			}

			const promise = Promise.resolve( sourceURI ).then( function ( sourceURI ) {

				return new Promise( function ( resolve, reject ) {

					let onLoad = resolve;
					if ( loader.isImageBitmapLoader === true ) {

						onLoad = function ( imageBitmap ) {

							const texture = new THREE.Texture( imageBitmap );
							texture.needsUpdate = true;
							resolve( texture );

						};

					}

					loader.load( THREE.LoaderUtils.resolveURL( sourceURI, options.path ), onLoad, undefined, reject );

				} );

			} ).then( function ( texture ) {

				// Clean up resources and configure THREE.Texture.

				if ( isObjectURL === true ) {

					URL.revokeObjectURL( sourceURI );

				}

				texture.userData.mimeType = sourceDef.mimeType || getImageURIMimeType( sourceDef.uri );
				return texture;

			} ).catch( function ( error ) {

				console.error( 'THREE.GLTFLoader: Couldn\'t load texture', sourceURI );
				throw error;

			} );
			this.sourceCache[ sourceIndex ] = promise;
			return promise;

		}

		/**
   * Asynchronously assigns a texture to the given material parameters.
   * @param {Object} materialParams
   * @param {string} mapName
   * @param {Object} mapDef
   * @return {Promise<Texture>}
   */
		assignTexture( materialParams, mapName, mapDef, encoding ) {

			const parser = this;
			return this.getDependency( 'texture', mapDef.index ).then( function ( texture ) {

				if ( ! texture ) return null;

				// Materials sample aoMap from UV set 1 and other maps from UV set 0 - this can't be configured
				// However, we will copy UV set 0 to UV set 1 on demand for aoMap
				if ( mapDef.texCoord !== undefined && mapDef.texCoord != 0 && ! ( mapName === 'aoMap' && mapDef.texCoord == 1 ) ) {

					console.warn( 'THREE.GLTFLoader: Custom UV set ' + mapDef.texCoord + ' for texture ' + mapName + ' not yet supported.' );

				}

				if ( parser.extensions[ EXTENSIONS.KHR_TEXTURE_TRANSFORM ] ) {

					const transform = mapDef.extensions !== undefined ? mapDef.extensions[ EXTENSIONS.KHR_TEXTURE_TRANSFORM ] : undefined;
					if ( transform ) {

						const gltfReference = parser.associations.get( texture );
						texture = parser.extensions[ EXTENSIONS.KHR_TEXTURE_TRANSFORM ].extendTexture( texture, transform );
						parser.associations.set( texture, gltfReference );

					}

				}

				if ( encoding !== undefined ) {

					texture.encoding = encoding;

				}

				materialParams[ mapName ] = texture;
				return texture;

			} );

		}

		/**
   * Assigns final material to a THREE.Mesh, THREE.Line, or THREE.Points instance. The instance
   * already has a material (generated from the glTF material options alone)
   * but reuse of the same glTF material may require multiple threejs materials
   * to accommodate different primitive types, defines, etc. New materials will
   * be created if necessary, and reused from a cache.
   * @param  {Object3D} mesh THREE.Mesh, THREE.Line, or THREE.Points instance.
   */
		assignFinalMaterial( mesh ) {

			const geometry = mesh.geometry;
			let material = mesh.material;
			const useDerivativeTangents = geometry.attributes.tangent === undefined;
			const useVertexColors = geometry.attributes.color !== undefined;
			const useFlatShading = geometry.attributes.normal === undefined;
			if ( mesh.isPoints ) {

				const cacheKey = 'PointsMaterial:' + material.uuid;
				let pointsMaterial = this.cache.get( cacheKey );
				if ( ! pointsMaterial ) {

					pointsMaterial = new THREE.PointsMaterial();
					THREE.Material.prototype.copy.call( pointsMaterial, material );
					pointsMaterial.color.copy( material.color );
					pointsMaterial.map = material.map;
					pointsMaterial.sizeAttenuation = false; // glTF spec says points should be 1px

					this.cache.add( cacheKey, pointsMaterial );

				}

				material = pointsMaterial;

			} else if ( mesh.isLine ) {

				const cacheKey = 'LineBasicMaterial:' + material.uuid;
				let lineMaterial = this.cache.get( cacheKey );
				if ( ! lineMaterial ) {

					lineMaterial = new THREE.LineBasicMaterial();
					THREE.Material.prototype.copy.call( lineMaterial, material );
					lineMaterial.color.copy( material.color );
					this.cache.add( cacheKey, lineMaterial );

				}

				material = lineMaterial;

			}

			// Clone the material if it will be modified
			if ( useDerivativeTangents || useVertexColors || useFlatShading ) {

				let cacheKey = 'ClonedMaterial:' + material.uuid + ':';
				if ( useDerivativeTangents ) cacheKey += 'derivative-tangents:';
				if ( useVertexColors ) cacheKey += 'vertex-colors:';
				if ( useFlatShading ) cacheKey += 'flat-shading:';
				let cachedMaterial = this.cache.get( cacheKey );
				if ( ! cachedMaterial ) {

					cachedMaterial = material.clone();
					if ( useVertexColors ) cachedMaterial.vertexColors = true;
					if ( useFlatShading ) cachedMaterial.flatShading = true;
					if ( useDerivativeTangents ) {

						// https://github.com/mrdoob/three.js/issues/11438#issuecomment-507003995
						if ( cachedMaterial.normalScale ) cachedMaterial.normalScale.y *= - 1;
						if ( cachedMaterial.clearcoatNormalScale ) cachedMaterial.clearcoatNormalScale.y *= - 1;

					}

					this.cache.add( cacheKey, cachedMaterial );
					this.associations.set( cachedMaterial, this.associations.get( material ) );

				}

				material = cachedMaterial;

			}

			// workarounds for mesh and geometry

			if ( material.aoMap && geometry.attributes.uv2 === undefined && geometry.attributes.uv !== undefined ) {

				geometry.setAttribute( 'uv2', geometry.attributes.uv );

			}

			mesh.material = material;

		}
		getMaterialType() {

			return THREE.MeshStandardMaterial;

		}

		/**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#materials
   * @param {number} materialIndex
   * @return {Promise<Material>}
   */
		loadMaterial( materialIndex ) {

			const parser = this;
			const json = this.json;
			const extensions = this.extensions;
			const materialDef = json.materials[ materialIndex ];
			let materialType;
			const materialParams = {};
			const materialExtensions = materialDef.extensions || {};
			const pending = [];
			if ( materialExtensions[ EXTENSIONS.KHR_MATERIALS_UNLIT ] ) {

				const kmuExtension = extensions[ EXTENSIONS.KHR_MATERIALS_UNLIT ];
				materialType = kmuExtension.getMaterialType();
				pending.push( kmuExtension.extendParams( materialParams, materialDef, parser ) );

			} else {

				// Specification:
				// https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#metallic-roughness-material

				const metallicRoughness = materialDef.pbrMetallicRoughness || {};
				materialParams.color = new THREE.Color( 1.0, 1.0, 1.0 );
				materialParams.opacity = 1.0;
				if ( Array.isArray( metallicRoughness.baseColorFactor ) ) {

					const array = metallicRoughness.baseColorFactor;
					materialParams.color.fromArray( array );
					materialParams.opacity = array[ 3 ];

				}

				if ( metallicRoughness.baseColorTexture !== undefined ) {

					pending.push( parser.assignTexture( materialParams, 'map', metallicRoughness.baseColorTexture, THREE.sRGBEncoding ) );

				}

				materialParams.metalness = metallicRoughness.metallicFactor !== undefined ? metallicRoughness.metallicFactor : 1.0;
				materialParams.roughness = metallicRoughness.roughnessFactor !== undefined ? metallicRoughness.roughnessFactor : 1.0;
				if ( metallicRoughness.metallicRoughnessTexture !== undefined ) {

					pending.push( parser.assignTexture( materialParams, 'metalnessMap', metallicRoughness.metallicRoughnessTexture ) );
					pending.push( parser.assignTexture( materialParams, 'roughnessMap', metallicRoughness.metallicRoughnessTexture ) );

				}

				materialType = this._invokeOne( function ( ext ) {

					return ext.getMaterialType && ext.getMaterialType( materialIndex );

				} );
				pending.push( Promise.all( this._invokeAll( function ( ext ) {

					return ext.extendMaterialParams && ext.extendMaterialParams( materialIndex, materialParams );

				} ) ) );

			}

			if ( materialDef.doubleSided === true ) {

				materialParams.side = THREE.DoubleSide;

			}

			const alphaMode = materialDef.alphaMode || ALPHA_MODES.OPAQUE;
			if ( alphaMode === ALPHA_MODES.BLEND ) {

				materialParams.transparent = true;

				// See: https://github.com/mrdoob/three.js/issues/17706
				materialParams.depthWrite = false;

			} else {

				materialParams.transparent = false;
				if ( alphaMode === ALPHA_MODES.MASK ) {

					materialParams.alphaTest = materialDef.alphaCutoff !== undefined ? materialDef.alphaCutoff : 0.5;

				}

			}

			if ( materialDef.normalTexture !== undefined && materialType !== THREE.MeshBasicMaterial ) {

				pending.push( parser.assignTexture( materialParams, 'normalMap', materialDef.normalTexture ) );
				materialParams.normalScale = new THREE.Vector2( 1, 1 );
				if ( materialDef.normalTexture.scale !== undefined ) {

					const scale = materialDef.normalTexture.scale;
					materialParams.normalScale.set( scale, scale );

				}

			}

			if ( materialDef.occlusionTexture !== undefined && materialType !== THREE.MeshBasicMaterial ) {

				pending.push( parser.assignTexture( materialParams, 'aoMap', materialDef.occlusionTexture ) );
				if ( materialDef.occlusionTexture.strength !== undefined ) {

					materialParams.aoMapIntensity = materialDef.occlusionTexture.strength;

				}

			}

			if ( materialDef.emissiveFactor !== undefined && materialType !== THREE.MeshBasicMaterial ) {

				materialParams.emissive = new THREE.Color().fromArray( materialDef.emissiveFactor );

			}

			if ( materialDef.emissiveTexture !== undefined && materialType !== THREE.MeshBasicMaterial ) {

				pending.push( parser.assignTexture( materialParams, 'emissiveMap', materialDef.emissiveTexture, THREE.sRGBEncoding ) );

			}

			return Promise.all( pending ).then( function () {

				const material = new materialType( materialParams );
				if ( materialDef.name ) material.name = materialDef.name;
				assignExtrasToUserData( material, materialDef );
				parser.associations.set( material, {
					materials: materialIndex
				} );
				if ( materialDef.extensions ) addUnknownExtensionsToUserData( extensions, material, materialDef );
				return material;

			} );

		}

		/** When THREE.Object3D instances are targeted by animation, they need unique names. */
		createUniqueName( originalName ) {

			const sanitizedName = THREE.PropertyBinding.sanitizeNodeName( originalName || '' );
			let name = sanitizedName;
			for ( let i = 1; this.nodeNamesUsed[ name ]; ++ i ) {

				name = sanitizedName + '_' + i;

			}

			this.nodeNamesUsed[ name ] = true;
			return name;

		}

		/**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#geometry
   *
   * Creates BufferGeometries from primitives.
   *
   * @param {Array<GLTF.Primitive>} primitives
   * @return {Promise<Array<BufferGeometry>>}
   */
		loadGeometries( primitives ) {

			const parser = this;
			const extensions = this.extensions;
			const cache = this.primitiveCache;
			function createDracoPrimitive( primitive ) {

				return extensions[ EXTENSIONS.KHR_DRACO_MESH_COMPRESSION ].decodePrimitive( primitive, parser ).then( function ( geometry ) {

					return addPrimitiveAttributes( geometry, primitive, parser );

				} );

			}

			const pending = [];
			for ( let i = 0, il = primitives.length; i < il; i ++ ) {

				const primitive = primitives[ i ];
				const cacheKey = createPrimitiveKey( primitive );

				// See if we've already created this geometry
				const cached = cache[ cacheKey ];
				if ( cached ) {

					// Use the cached geometry if it exists
					pending.push( cached.promise );

				} else {

					let geometryPromise;
					if ( primitive.extensions && primitive.extensions[ EXTENSIONS.KHR_DRACO_MESH_COMPRESSION ] ) {

						// Use DRACO geometry if available
						geometryPromise = createDracoPrimitive( primitive );

					} else {

						// Otherwise create a new geometry
						geometryPromise = addPrimitiveAttributes( new THREE.BufferGeometry(), primitive, parser );

					}

					// Cache this geometry
					cache[ cacheKey ] = {
						primitive: primitive,
						promise: geometryPromise
					};
					pending.push( geometryPromise );

				}

			}

			return Promise.all( pending );

		}

		/**
   * Specification: https://github.com/KhronosGroup/glTF/blob/master/specification/2.0/README.md#meshes
   * @param {number} meshIndex
   * @return {Promise<Group|Mesh|SkinnedMesh>}
   */
		loadMesh( meshIndex ) {

			const parser = this;
			const json = this.json;
			const extensions = this.extensions;
			const meshDef = json.meshes[ meshIndex ];
			const primitives = meshDef.primitives;
			const pending = [];
			for ( let i = 0, il = primitives.length; i < il; i ++ ) {

				const material = primitives[ i ].material === undefined ? createDefaultMaterial( this.cache ) : this.getDependency( 'material', primitives[ i ].material );
				pending.push( material );

			}

			pending.push( parser.loadGeometries( primitives ) );
			return Promise.all( pending ).then( function ( results ) {

				const materials = results.slice( 0, results.length - 1 );
				const geometries = results[ results.length - 1 ];
				const meshes = [];
				for ( let i = 0, il = geometries.length; i < il; i ++ ) {

					const geometry = geometries[ i ];
					const primitive = primitives[ i ];

					// 1. create THREE.Mesh

					let mesh;
					const material = materials[ i ];
					if ( primitive.mode === WEBGL_CONSTANTS.TRIANGLES || primitive.mode === WEBGL_CONSTANTS.TRIANGLE_STRIP || primitive.mode === WEBGL_CONSTANTS.TRIANGLE_FAN || primitive.mode === undefined ) {

						// .isSkinnedMesh isn't in glTF spec. See ._markDefs()
						mesh = meshDef.isSkinnedMesh === true ? new THREE.SkinnedMesh( geometry, material ) : new THREE.Mesh( geometry, material );
						if ( mesh.isSkinnedMesh === true && ! mesh.geometry.attributes.skinWeight.normalized ) {

							// we normalize floating point skin weight array to fix malformed assets (see #15319)
							// it's important to skip this for non-float32 data since normalizeSkinWeights assumes non-normalized inputs
							mesh.normalizeSkinWeights();

						}

						if ( primitive.mode === WEBGL_CONSTANTS.TRIANGLE_STRIP ) {

							mesh.geometry = toTrianglesDrawMode( mesh.geometry, THREE.TriangleStripDrawMode );

						} else if ( primitive.mode === WEBGL_CONSTANTS.TRIANGLE_FAN ) {

							mesh.geometry = toTrianglesDrawMode( mesh.geometry, THREE.TriangleFanDrawMode );

						}

					} else if ( primitive.mode === WEBGL_CONSTANTS.LINES ) {

						mesh = new THREE.LineSegments( geometry, material );

					} else if ( primitive.mode === WEBGL_CONSTANTS.LINE_STRIP ) {

						mesh = new THREE.Line( geometry, material );

					} else if ( primitive.mode === WEBGL_CONSTANTS.LINE_LOOP ) {

						mesh = new THREE.LineLoop( geometry, material );

					} else if ( primitive.mode === WEBGL_CONSTANTS.POINTS ) {

						mesh = new THREE.Points( geometry, material );

					} else {

						throw new Error( 'THREE.GLTFLoader: Primitive mode unsupported: ' + primitive.mode );

					}

					if ( Object.keys( mesh.geometry.morphAttributes ).length > 0 ) {

						updateMorphTargets( mesh, meshDef );

					}

					mesh.name = parser.createUniqueName( meshDef.name || 'mesh_' + meshIndex );
					assignExtrasToUserData( mesh, meshDef );
					if ( primitive.extensions ) addUnknownExtensionsToUserData( extensions, mesh, primitive );
					parser.assignFinalMaterial( mesh );
					meshes.push( mesh );

				}

				for ( let i = 0, il = meshes.length; i < il; i ++ ) {

					parser.associations.set( meshes[ i ], {
						meshes: meshIndex,
						primitives: i
					} );

				}

				if ( meshes.length === 1 ) {

					return meshes[ 0 ];

				}

				const group = new THREE.Group();
				parser.associations.set( group, {
					meshes: meshIndex
				} );
				for ( let i = 0, il = meshes.length; i < il; i ++ ) {

					group.add( meshes[ i ] );

				}

				return group;

			} );

		}

		/**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#cameras
   * @param {number} cameraIndex
   * @return {Promise<THREE.Camera>}
   */
		loadCamera( cameraIndex ) {

			let camera;
			const cameraDef = this.json.cameras[ cameraIndex ];
			const params = cameraDef[ cameraDef.type ];
			if ( ! params ) {

				console.warn( 'THREE.GLTFLoader: Missing camera parameters.' );
				return;

			}

			if ( cameraDef.type === 'perspective' ) {

				camera = new THREE.PerspectiveCamera( THREE.MathUtils.radToDeg( params.yfov ), params.aspectRatio || 1, params.znear || 1, params.zfar || 2e6 );

			} else if ( cameraDef.type === 'orthographic' ) {

				camera = new THREE.OrthographicCamera( - params.xmag, params.xmag, params.ymag, - params.ymag, params.znear, params.zfar );

			}

			if ( cameraDef.name ) camera.name = this.createUniqueName( cameraDef.name );
			assignExtrasToUserData( camera, cameraDef );
			return Promise.resolve( camera );

		}

		/**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#skins
   * @param {number} skinIndex
   * @return {Promise<Skeleton>}
   */
		loadSkin( skinIndex ) {

			const skinDef = this.json.skins[ skinIndex ];
			const pending = [];
			for ( let i = 0, il = skinDef.joints.length; i < il; i ++ ) {

				pending.push( this.getDependency( 'node', skinDef.joints[ i ] ) );

			}

			if ( skinDef.inverseBindMatrices !== undefined ) {

				pending.push( this.getDependency( 'accessor', skinDef.inverseBindMatrices ) );

			} else {

				pending.push( null );

			}

			return Promise.all( pending ).then( function ( results ) {

				const inverseBindMatrices = results.pop();
				const jointNodes = results;
				const bones = [];
				const boneInverses = [];
				for ( let i = 0, il = jointNodes.length; i < il; i ++ ) {

					const jointNode = jointNodes[ i ];
					if ( jointNode ) {

						bones.push( jointNode );
						const mat = new THREE.Matrix4();
						if ( inverseBindMatrices !== null ) {

							mat.fromArray( inverseBindMatrices.array, i * 16 );

						}

						boneInverses.push( mat );

					} else {

						console.warn( 'THREE.GLTFLoader: Joint "%s" could not be found.', skinDef.joints[ i ] );

					}

				}

				return new THREE.Skeleton( bones, boneInverses );

			} );

		}

		/**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#animations
   * @param {number} animationIndex
   * @return {Promise<AnimationClip>}
   */
		loadAnimation( animationIndex ) {

			const json = this.json;
			const animationDef = json.animations[ animationIndex ];
			const pendingNodes = [];
			const pendingInputAccessors = [];
			const pendingOutputAccessors = [];
			const pendingSamplers = [];
			const pendingTargets = [];
			for ( let i = 0, il = animationDef.channels.length; i < il; i ++ ) {

				const channel = animationDef.channels[ i ];
				const sampler = animationDef.samplers[ channel.sampler ];
				const target = channel.target;
				const name = target.node;
				const input = animationDef.parameters !== undefined ? animationDef.parameters[ sampler.input ] : sampler.input;
				const output = animationDef.parameters !== undefined ? animationDef.parameters[ sampler.output ] : sampler.output;
				pendingNodes.push( this.getDependency( 'node', name ) );
				pendingInputAccessors.push( this.getDependency( 'accessor', input ) );
				pendingOutputAccessors.push( this.getDependency( 'accessor', output ) );
				pendingSamplers.push( sampler );
				pendingTargets.push( target );

			}

			return Promise.all( [ Promise.all( pendingNodes ), Promise.all( pendingInputAccessors ), Promise.all( pendingOutputAccessors ), Promise.all( pendingSamplers ), Promise.all( pendingTargets ) ] ).then( function ( dependencies ) {

				const nodes = dependencies[ 0 ];
				const inputAccessors = dependencies[ 1 ];
				const outputAccessors = dependencies[ 2 ];
				const samplers = dependencies[ 3 ];
				const targets = dependencies[ 4 ];
				const tracks = [];
				for ( let i = 0, il = nodes.length; i < il; i ++ ) {

					const node = nodes[ i ];
					const inputAccessor = inputAccessors[ i ];
					const outputAccessor = outputAccessors[ i ];
					const sampler = samplers[ i ];
					const target = targets[ i ];
					if ( node === undefined ) continue;
					node.updateMatrix();
					let TypedKeyframeTrack;
					switch ( PATH_PROPERTIES[ target.path ] ) {

						case PATH_PROPERTIES.weights:
							TypedKeyframeTrack = THREE.NumberKeyframeTrack;
							break;
						case PATH_PROPERTIES.rotation:
							TypedKeyframeTrack = THREE.QuaternionKeyframeTrack;
							break;
						case PATH_PROPERTIES.position:
						case PATH_PROPERTIES.scale:
						default:
							TypedKeyframeTrack = THREE.VectorKeyframeTrack;
							break;

					}

					const targetName = node.name ? node.name : node.uuid;
					const interpolation = sampler.interpolation !== undefined ? INTERPOLATION[ sampler.interpolation ] : THREE.InterpolateLinear;
					const targetNames = [];
					if ( PATH_PROPERTIES[ target.path ] === PATH_PROPERTIES.weights ) {

						node.traverse( function ( object ) {

							if ( object.morphTargetInfluences ) {

								targetNames.push( object.name ? object.name : object.uuid );

							}

						} );

					} else {

						targetNames.push( targetName );

					}

					let outputArray = outputAccessor.array;
					if ( outputAccessor.normalized ) {

						const scale = getNormalizedComponentScale( outputArray.constructor );
						const scaled = new Float32Array( outputArray.length );
						for ( let j = 0, jl = outputArray.length; j < jl; j ++ ) {

							scaled[ j ] = outputArray[ j ] * scale;

						}

						outputArray = scaled;

					}

					for ( let j = 0, jl = targetNames.length; j < jl; j ++ ) {

						const track = new TypedKeyframeTrack( targetNames[ j ] + '.' + PATH_PROPERTIES[ target.path ], inputAccessor.array, outputArray, interpolation );

						// Override interpolation with custom factory method.
						if ( sampler.interpolation === 'CUBICSPLINE' ) {

							track.createInterpolant = function InterpolantFactoryMethodGLTFCubicSpline( result ) {

								// A CUBICSPLINE keyframe in glTF has three output values for each input value,
								// representing inTangent, splineVertex, and outTangent. As a result, track.getValueSize()
								// must be divided by three to get the interpolant's sampleSize argument.

								const interpolantType = this instanceof THREE.QuaternionKeyframeTrack ? GLTFCubicSplineQuaternionInterpolant : GLTFCubicSplineInterpolant;
								return new interpolantType( this.times, this.values, this.getValueSize() / 3, result );

							};

							// Mark as CUBICSPLINE. `track.getInterpolation()` doesn't support custom interpolants.
							track.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline = true;

						}

						tracks.push( track );

					}

				}

				const name = animationDef.name ? animationDef.name : 'animation_' + animationIndex;
				return new THREE.AnimationClip( name, undefined, tracks );

			} );

		}
		createNodeMesh( nodeIndex ) {

			const json = this.json;
			const parser = this;
			const nodeDef = json.nodes[ nodeIndex ];
			if ( nodeDef.mesh === undefined ) return null;
			return parser.getDependency( 'mesh', nodeDef.mesh ).then( function ( mesh ) {

				const node = parser._getNodeRef( parser.meshCache, nodeDef.mesh, mesh );

				// if weights are provided on the node, override weights on the mesh.
				if ( nodeDef.weights !== undefined ) {

					node.traverse( function ( o ) {

						if ( ! o.isMesh ) return;
						for ( let i = 0, il = nodeDef.weights.length; i < il; i ++ ) {

							o.morphTargetInfluences[ i ] = nodeDef.weights[ i ];

						}

					} );

				}

				return node;

			} );

		}

		/**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#nodes-and-hierarchy
   * @param {number} nodeIndex
   * @return {Promise<Object3D>}
   */
		loadNode( nodeIndex ) {

			const json = this.json;
			const extensions = this.extensions;
			const parser = this;
			const nodeDef = json.nodes[ nodeIndex ];

			// reserve node's name before its dependencies, so the root has the intended name.
			const nodeName = nodeDef.name ? parser.createUniqueName( nodeDef.name ) : '';
			return function () {

				const pending = [];
				const meshPromise = parser._invokeOne( function ( ext ) {

					return ext.createNodeMesh && ext.createNodeMesh( nodeIndex );

				} );
				if ( meshPromise ) {

					pending.push( meshPromise );

				}

				if ( nodeDef.camera !== undefined ) {

					pending.push( parser.getDependency( 'camera', nodeDef.camera ).then( function ( camera ) {

						return parser._getNodeRef( parser.cameraCache, nodeDef.camera, camera );

					} ) );

				}

				parser._invokeAll( function ( ext ) {

					return ext.createNodeAttachment && ext.createNodeAttachment( nodeIndex );

				} ).forEach( function ( promise ) {

					pending.push( promise );

				} );
				return Promise.all( pending );

			}().then( function ( objects ) {

				let node;

				// .isBone isn't in glTF spec. See ._markDefs
				if ( nodeDef.isBone === true ) {

					node = new THREE.Bone();

				} else if ( objects.length > 1 ) {

					node = new THREE.Group();

				} else if ( objects.length === 1 ) {

					node = objects[ 0 ];

				} else {

					node = new THREE.Object3D();

				}

				if ( node !== objects[ 0 ] ) {

					for ( let i = 0, il = objects.length; i < il; i ++ ) {

						node.add( objects[ i ] );

					}

				}

				if ( nodeDef.name ) {

					node.userData.name = nodeDef.name;
					node.name = nodeName;

				}

				assignExtrasToUserData( node, nodeDef );
				if ( nodeDef.extensions ) addUnknownExtensionsToUserData( extensions, node, nodeDef );
				if ( nodeDef.matrix !== undefined ) {

					const matrix = new THREE.Matrix4();
					matrix.fromArray( nodeDef.matrix );
					node.applyMatrix4( matrix );

				} else {

					if ( nodeDef.translation !== undefined ) {

						node.position.fromArray( nodeDef.translation );

					}

					if ( nodeDef.rotation !== undefined ) {

						node.quaternion.fromArray( nodeDef.rotation );

					}

					if ( nodeDef.scale !== undefined ) {

						node.scale.fromArray( nodeDef.scale );

					}

				}

				if ( ! parser.associations.has( node ) ) {

					parser.associations.set( node, {} );

				}

				parser.associations.get( node ).nodes = nodeIndex;
				return node;

			} );

		}

		/**
   * Specification: https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#scenes
   * @param {number} sceneIndex
   * @return {Promise<Group>}
   */
		loadScene( sceneIndex ) {

			const json = this.json;
			const extensions = this.extensions;
			const sceneDef = this.json.scenes[ sceneIndex ];
			const parser = this;

			// THREE.Loader returns THREE.Group, not Scene.
			// See: https://github.com/mrdoob/three.js/issues/18342#issuecomment-578981172
			const scene = new THREE.Group();
			if ( sceneDef.name ) scene.name = parser.createUniqueName( sceneDef.name );
			assignExtrasToUserData( scene, sceneDef );
			if ( sceneDef.extensions ) addUnknownExtensionsToUserData( extensions, scene, sceneDef );
			const nodeIds = sceneDef.nodes || [];
			const pending = [];
			for ( let i = 0, il = nodeIds.length; i < il; i ++ ) {

				pending.push( buildNodeHierarchy( nodeIds[ i ], scene, json, parser ) );

			}

			return Promise.all( pending ).then( function () {

				// Removes dangling associations, associations that reference a node that
				// didn't make it into the scene.
				const reduceAssociations = node => {

					const reducedAssociations = new Map();
					for ( const [ key, value ] of parser.associations ) {

						if ( key instanceof THREE.Material || key instanceof THREE.Texture ) {

							reducedAssociations.set( key, value );

						}

					}

					node.traverse( node => {

						const mappings = parser.associations.get( node );
						if ( mappings != null ) {

							reducedAssociations.set( node, mappings );

						}

					} );
					return reducedAssociations;

				};

				parser.associations = reduceAssociations( scene );
				return scene;

			} );

		}

	}
	function buildNodeHierarchy( nodeId, parentObject, json, parser ) {

		const nodeDef = json.nodes[ nodeId ];
		return parser.getDependency( 'node', nodeId ).then( function ( node ) {

			if ( nodeDef.skin === undefined ) return node;

			// build skeleton here as well

			return parser.getDependency( 'skin', nodeDef.skin ).then( function ( skeleton ) {

				node.traverse( function ( mesh ) {

					if ( ! mesh.isSkinnedMesh ) return;
					mesh.bind( skeleton, mesh.matrixWorld );

				} );
				return node;

			} );

		} ).then( function ( node ) {

			// build node hierachy

			parentObject.add( node );
			const pending = [];
			if ( nodeDef.children ) {

				const children = nodeDef.children;
				for ( let i = 0, il = children.length; i < il; i ++ ) {

					const child = children[ i ];
					pending.push( buildNodeHierarchy( child, node, json, parser ) );

				}

			}

			return Promise.all( pending );

		} );

	}

	/**
 * @param {BufferGeometry} geometry
 * @param {GLTF.Primitive} primitiveDef
 * @param {GLTFParser} parser
 */
	function computeBounds( geometry, primitiveDef, parser ) {

		const attributes = primitiveDef.attributes;
		const box = new THREE.Box3();
		if ( attributes.POSITION !== undefined ) {

			const accessor = parser.json.accessors[ attributes.POSITION ];
			const min = accessor.min;
			const max = accessor.max;

			// glTF requires 'min' and 'max', but VRM (which extends glTF) currently ignores that requirement.

			if ( min !== undefined && max !== undefined ) {

				box.set( new THREE.Vector3( min[ 0 ], min[ 1 ], min[ 2 ] ), new THREE.Vector3( max[ 0 ], max[ 1 ], max[ 2 ] ) );
				if ( accessor.normalized ) {

					const boxScale = getNormalizedComponentScale( WEBGL_COMPONENT_TYPES[ accessor.componentType ] );
					box.min.multiplyScalar( boxScale );
					box.max.multiplyScalar( boxScale );

				}

			} else {

				console.warn( 'THREE.GLTFLoader: Missing min/max properties for accessor POSITION.' );
				return;

			}

		} else {

			return;

		}

		const targets = primitiveDef.targets;
		if ( targets !== undefined ) {

			const maxDisplacement = new THREE.Vector3();
			const vector = new THREE.Vector3();
			for ( let i = 0, il = targets.length; i < il; i ++ ) {

				const target = targets[ i ];
				if ( target.POSITION !== undefined ) {

					const accessor = parser.json.accessors[ target.POSITION ];
					const min = accessor.min;
					const max = accessor.max;

					// glTF requires 'min' and 'max', but VRM (which extends glTF) currently ignores that requirement.

					if ( min !== undefined && max !== undefined ) {

						// we need to get max of absolute components because target weight is [-1,1]
						vector.setX( Math.max( Math.abs( min[ 0 ] ), Math.abs( max[ 0 ] ) ) );
						vector.setY( Math.max( Math.abs( min[ 1 ] ), Math.abs( max[ 1 ] ) ) );
						vector.setZ( Math.max( Math.abs( min[ 2 ] ), Math.abs( max[ 2 ] ) ) );
						if ( accessor.normalized ) {

							const boxScale = getNormalizedComponentScale( WEBGL_COMPONENT_TYPES[ accessor.componentType ] );
							vector.multiplyScalar( boxScale );

						}

						// Note: this assumes that the sum of all weights is at most 1. This isn't quite correct - it's more conservative
						// to assume that each target can have a max weight of 1. However, for some use cases - notably, when morph targets
						// are used to implement key-frame animations and as such only two are active at a time - this results in very large
						// boxes. So for now we make a box that's sometimes a touch too small but is hopefully mostly of reasonable size.
						maxDisplacement.max( vector );

					} else {

						console.warn( 'THREE.GLTFLoader: Missing min/max properties for accessor POSITION.' );

					}

				}

			}

			// As per comment above this box isn't conservative, but has a reasonable size for a very large number of morph targets.
			box.expandByVector( maxDisplacement );

		}

		geometry.boundingBox = box;
		const sphere = new THREE.Sphere();
		box.getCenter( sphere.center );
		sphere.radius = box.min.distanceTo( box.max ) / 2;
		geometry.boundingSphere = sphere;

	}

	/**
 * @param {BufferGeometry} geometry
 * @param {GLTF.Primitive} primitiveDef
 * @param {GLTFParser} parser
 * @return {Promise<BufferGeometry>}
 */
	function addPrimitiveAttributes( geometry, primitiveDef, parser ) {

		const attributes = primitiveDef.attributes;
		const pending = [];
		function assignAttributeAccessor( accessorIndex, attributeName ) {

			return parser.getDependency( 'accessor', accessorIndex ).then( function ( accessor ) {

				geometry.setAttribute( attributeName, accessor );

			} );

		}

		for ( const gltfAttributeName in attributes ) {

			const threeAttributeName = ATTRIBUTES[ gltfAttributeName ] || gltfAttributeName.toLowerCase();

			// Skip attributes already provided by e.g. Draco extension.
			if ( threeAttributeName in geometry.attributes ) continue;
			pending.push( assignAttributeAccessor( attributes[ gltfAttributeName ], threeAttributeName ) );

		}

		if ( primitiveDef.indices !== undefined && ! geometry.index ) {

			const accessor = parser.getDependency( 'accessor', primitiveDef.indices ).then( function ( accessor ) {

				geometry.setIndex( accessor );

			} );
			pending.push( accessor );

		}

		assignExtrasToUserData( geometry, primitiveDef );
		computeBounds( geometry, primitiveDef, parser );
		return Promise.all( pending ).then( function () {

			return primitiveDef.targets !== undefined ? addMorphTargets( geometry, primitiveDef.targets, parser ) : geometry;

		} );

	}

	/**
 * @param {BufferGeometry} geometry
 * @param {Number} drawMode
 * @return {BufferGeometry}
 */
	function toTrianglesDrawMode( geometry, drawMode ) {

		let index = geometry.getIndex();

		// generate index if not present

		if ( index === null ) {

			const indices = [];
			const position = geometry.getAttribute( 'position' );
			if ( position !== undefined ) {

				for ( let i = 0; i < position.count; i ++ ) {

					indices.push( i );

				}

				geometry.setIndex( indices );
				index = geometry.getIndex();

			} else {

				console.error( 'THREE.GLTFLoader.toTrianglesDrawMode(): Undefined position attribute. Processing not possible.' );
				return geometry;

			}

		}

		//

		const numberOfTriangles = index.count - 2;
		const newIndices = [];
		if ( drawMode === THREE.TriangleFanDrawMode ) {

			// gl.TRIANGLE_FAN

			for ( let i = 1; i <= numberOfTriangles; i ++ ) {

				newIndices.push( index.getX( 0 ) );
				newIndices.push( index.getX( i ) );
				newIndices.push( index.getX( i + 1 ) );

			}

		} else {

			// gl.TRIANGLE_STRIP

			for ( let i = 0; i < numberOfTriangles; i ++ ) {

				if ( i % 2 === 0 ) {

					newIndices.push( index.getX( i ) );
					newIndices.push( index.getX( i + 1 ) );
					newIndices.push( index.getX( i + 2 ) );

				} else {

					newIndices.push( index.getX( i + 2 ) );
					newIndices.push( index.getX( i + 1 ) );
					newIndices.push( index.getX( i ) );

				}

			}

		}

		if ( newIndices.length / 3 !== numberOfTriangles ) {

			console.error( 'THREE.GLTFLoader.toTrianglesDrawMode(): Unable to generate correct amount of triangles.' );

		}

		// build final geometry

		const newGeometry = geometry.clone();
		newGeometry.setIndex( newIndices );
		return newGeometry;

	}

	THREE.GLTFLoader = GLTFLoader;

} )();
