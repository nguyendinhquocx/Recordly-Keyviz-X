import {
	type MouseEvent,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";

export function useLaunchHudInteractionState({
	openId,
	hudDialogOpen,
	isHudDraggingRef,
	isWebcamPreviewDraggingRef,
	webcamPreviewDragStartRef,
}: {
	openId: string | null;
	hudDialogOpen: boolean;
	isHudDraggingRef: RefObject<boolean>;
	isWebcamPreviewDraggingRef: RefObject<boolean>;
	webcamPreviewDragStartRef: RefObject<unknown>;
}) {
	const isMouseOverHudRef = useRef(false);
	const timeoutRef = useRef<NodeJS.Timeout | null>(null);
	const interactiveOverlayOpen = openId !== null || hudDialogOpen;

	useLayoutEffect(() => {
		if (interactiveOverlayOpen) {
			isMouseOverHudRef.current = true;
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			setIgnoring(false, true);
		} else {
			isMouseOverHudRef.current = false;
			const timer = setTimeout(() => {
				if (!isMouseOverHudRef.current) {
					window.electronAPI?.hudOverlaySetIgnoreMouse?.(true);
				}
			}, 150);
			return () => clearTimeout(timer);
		}
	}, [interactiveOverlayOpen]);

	useEffect(() => {
		const handleMouseOver = (e: globalThis.MouseEvent) => {
			// Electron forwards mousemove while clicks pass through. Target ancestry
			// is unreliable there, especially inside transparent full-width wrappers.
			const isInteractive = isPointerOverHudSurface(
				getHudInteractiveBounds(document),
				e.clientX,
				e.clientY,
			);

			if (isInteractive) {
				isMouseOverHudRef.current = true;
				if (timeoutRef.current) clearTimeout(timeoutRef.current);
				window.electronAPI?.hudOverlaySetIgnoreMouse?.(false);
			} else if (!interactiveOverlayOpen) {
				isMouseOverHudRef.current = false;
				if (timeoutRef.current) clearTimeout(timeoutRef.current);
				timeoutRef.current = setTimeout(() => {
					if (
						!interactiveOverlayOpen &&
						!isHudDraggingRef.current &&
						!isWebcamPreviewDraggingRef.current &&
						!webcamPreviewDragStartRef.current &&
						!isMouseOverHudRef.current
					) {
						setIgnoring(true);
					}
				}, 0);
			}
		};

		window.addEventListener("mousemove", handleMouseOver);
		window.addEventListener("mouseover", handleMouseOver);
		return () => window.removeEventListener("mouseover", handleMouseOver);
	}, [interactiveOverlayOpen, isHudDraggingRef, isWebcamPreviewDraggingRef, webcamPreviewDragStartRef]);

	const beginInteractiveHudAction = useCallback(() => {
		isMouseOverHudRef.current = true;
		setIgnoring(false, true);
	}, [setIgnoring]);

	const handleHudMouseEnter = useCallback(() => {
		isMouseOverHudRef.current = true;
		if (timeoutRef.current) clearTimeout(timeoutRef.current);
		setIgnoring(false, true);
	}, [setIgnoring]);

	const handleHudMouseLeave = useCallback(
		(event: MouseEvent<HTMLDivElement>) => {
			const nextTarget = event.relatedTarget;
			if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
				return;
			}

			isMouseOverHudRef.current = false;

			if (timeoutRef.current) clearTimeout(timeoutRef.current);

			timeoutRef.current = setTimeout(() => {
				if (
					!interactiveOverlayOpen &&
					!isHudDraggingRef.current &&
					!isWebcamPreviewDraggingRef.current &&
					!webcamPreviewDragStartRef.current &&
					!isMouseOverHudRef.current
				) {
					setIgnoring(true);
				}
			}, 0);
		},
		[interactiveOverlayOpen, isHudDraggingRef, isWebcamPreviewDraggingRef, webcamPreviewDragStartRef],
	);

	return {
		handleHudMouseEnter,
		handleHudMouseLeave,
		beginInteractiveHudAction,
	};
}
