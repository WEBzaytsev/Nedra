#import <AppKit/AppKit.h>

void nedra_observe_lock(void (*lock)(void)) {
    NSNotificationCenter *workspace = NSWorkspace.sharedWorkspace.notificationCenter;
    for (NSString *name in @[NSWorkspaceWillSleepNotification,
                            NSWorkspaceScreensDidSleepNotification,
                            NSWorkspaceSessionDidResignActiveNotification]) {
        [workspace addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification * _Nonnull note) { (void)note; lock(); }];
    }


    [NSDistributedNotificationCenter.defaultCenter addObserverForName:@"com.apple.screenIsLocked"
        object:nil queue:nil usingBlock:^(NSNotification * _Nonnull note) { (void)note; lock(); }];
}
long nedra_clipboard_generation(void) {
    @autoreleasepool { return NSPasteboard.generalPasteboard.changeCount; }
}
