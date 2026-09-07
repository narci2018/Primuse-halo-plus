//
//  SafeSiriBridge.h
//  Primuse
//

#import <Foundation/Foundation.h>
#import <TargetConditionals.h>

#if TARGET_OS_IOS
#import <Intents/Intents.h>
#endif

NS_ASSUME_NONNULL_BEGIN

@interface SafeSiriBridge : NSObject

+ (BOOL)hasSiriEntitlement;

#if TARGET_OS_IOS
+ (INSiriAuthorizationStatus)safeSiriAuthorizationStatus;
+ (void)safeRequestSiriAuthorization:(void (^)(INSiriAuthorizationStatus status))completion;
#endif

@end

NS_ASSUME_NONNULL_END
