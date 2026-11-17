#import <AppKit/AppKit.h>
// Observers live for the application lifetime. Notifications carry no data into Rust.
void nedra_observe_lock(void (*lock)(void)) {
    NSNotificationCenter *workspace = NSWorkspace.sharedWorkspace.notificationCenter;
    for (NSString *name in @[NSWorkspaceWillSleepNotification,
                            NSWorkspaceScreensDidSleepNotification,
                            NSWorkspaceSessionDidResignActiveNotification]) {
        [workspace addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification * _Nonnull note) { (void)note; lock(); }];
    }
    // This system notification is not a documented API. Screen sleep and
    // session resignation above are supported fallbacks; it can only lock.
    [NSDistributedNotificationCenter.defaultCenter addObserverForName:@"com.apple.screenIsLocked"
        object:nil queue:nil usingBlock:^(NSNotification * _Nonnull note) { (void)note; lock(); }];
}
long nedra_clipboard_generation(void) {
    @autoreleasepool { return NSPasteboard.generalPasteboard.changeCount; }
}

#if NEDRA_QA
static NSView *nedra_qa_webview(NSView *view) {
    Class webViewClass = NSClassFromString(@"WKWebView");
    if (webViewClass != Nil && [view isKindOfClass:webViewClass]) return view;
    for (NSView *child in view.subviews) {
        NSView *webView = nedra_qa_webview(child);
        if (webView != nil) return webView;
    }
    return nil;
}
void nedra_test_sleep_notification(void) {
    [NSWorkspace.sharedWorkspace.notificationCenter postNotificationName:NSWorkspaceWillSleepNotification object:NSWorkspace.sharedWorkspace];
}
bool nedra_qa_tab(void) {
    __block bool sent = false;
    void (^press)(void) = ^{
        NSWindow *window = nil;
        CGFloat largestArea = 0;
        for (NSWindow *candidate in NSApp.windows) {
            CGFloat area = NSWidth(candidate.frame) * NSHeight(candidate.frame);
            if (candidate.isVisible && area > largestArea) {
                window = candidate;
                largestArea = area;
            }
        }
        NSView *webView = window == nil ? nil : nedra_qa_webview(window.contentView);
        if (webView == nil) return;
        NSResponder *first = window.firstResponder;
        if ((![first isKindOfClass:NSView.class] || ![(NSView *)first isDescendantOf:webView])
            && ![window makeFirstResponder:webView]) return;
        CGEventRef down = CGEventCreateKeyboardEvent(NULL, 48, true);
        CGEventRef up = CGEventCreateKeyboardEvent(NULL, 48, false);
        if (down == NULL || up == NULL) {
            if (down != NULL) CFRelease(down);
            if (up != NULL) CFRelease(up);
            return;
        }
        [window makeKeyAndOrderFront:nil];
        pid_t pid = NSProcessInfo.processInfo.processIdentifier;
        CGEventPostToPid(pid, down);
        CGEventPostToPid(pid, up);
        CFRelease(down);
        CFRelease(up);
        sent = true;
    };
    if (NSThread.isMainThread) press(); else dispatch_sync(dispatch_get_main_queue(), press);
    return sent;
}
bool nedra_qa_click(double x, double y) {
    __block bool sent = false;
    void (^click)(void) = ^{
        NSWindow *window = nil;
        CGFloat largestArea = 0;
        for (NSWindow *candidate in NSApp.windows) {
            CGFloat area = NSWidth(candidate.frame) * NSHeight(candidate.frame);
            if (candidate.isVisible && area > largestArea) {
                window = candidate;
                largestArea = area;
            }
        }
        if (window == nil) return;
        NSView *webView = nedra_qa_webview(window.contentView);
        if (webView == nil || x < 0 || y < 0 || x >= NSWidth(webView.bounds) || y >= NSHeight(webView.bounds)) return;
        NSPoint local = NSMakePoint(x, webView.isFlipped ? y : NSHeight(webView.bounds) - y);
        if ([webView hitTest:local] == nil) return;
        NSPoint windowPoint = [webView convertPoint:local toView:nil];
        NSPoint screenPoint = [window convertPointToScreen:windowPoint];
        CGRect mainDisplay = CGDisplayBounds(CGMainDisplayID());
        CGPoint quartzPoint = CGPointMake(
            screenPoint.x,
            CGRectGetMaxY(mainDisplay) - screenPoint.y
        );
        CGEventRef moved = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, quartzPoint, kCGMouseButtonLeft);
        CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, quartzPoint, kCGMouseButtonLeft);
        CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, quartzPoint, kCGMouseButtonLeft);
        if (moved == NULL || down == NULL || up == NULL) {
            if (moved != NULL) CFRelease(moved);
            if (down != NULL) CFRelease(down);
            if (up != NULL) CFRelease(up);
            return;
        }
        [window makeKeyAndOrderFront:nil];
        pid_t pid = NSProcessInfo.processInfo.processIdentifier;
        CGEventPostToPid(pid, moved);
        CGEventPostToPid(pid, down);
        CGEventPostToPid(pid, up);
        CFRelease(moved);
        CFRelease(down);
        CFRelease(up);
        sent = true;
    };
    if (NSThread.isMainThread) click(); else dispatch_sync(dispatch_get_main_queue(), click);
    return sent;
}
#endif
